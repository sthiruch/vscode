/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as cp from 'child_process';
// import * as playwright from '@playwright/test';
import * as url from 'url';
import * as tmp from 'tmp';
import * as rimraf from 'rimraf';
import { URI } from 'vscode-uri';
import * as kill from 'tree-kill';
import * as optimistLib from 'optimist';
import { promisify } from 'util';

import * as playwright from 'playwright';

const optimist = optimistLib
	.describe('workspacePath', 'path to the workspace (folder or *.code-workspace file) to open in the test').string('workspacePath')
	.describe('extensionDevelopmentPath', 'path to the extension to test').string('extensionDevelopmentPath')
	.describe('extensionTestsPath', 'path to the extension tests').string('extensionTestsPath')
	.describe('debug', 'do not run browsers headless').boolean('debug')
	.describe('wsEndpoint', 'A browser websocket endpoint to connect to.').string('wsEndpoint')
	.describe('help', 'show the help').alias('help', 'h');

if (optimist.argv.help) {
	optimist.showHelp();
	process.exit(0);
}

const width = 1200;
const height = 800;

async function runTestsInBrowser(wsEndpoint: string, endpoint: url.UrlWithStringQuery, server: cp.ChildProcess): Promise<void> {
	const browser = await playwright.chromium.connect(wsEndpoint);
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.setViewportSize({ width, height });

	page.on('pageerror', async error => console.error(`Playwright ERROR: page error: ${error}`));
	page.on('crash', page => console.error('Playwright ERROR: page crash'));
	page.on('response', async response => {
		if (response.status() >= 400) {
			console.error(`Playwright ERROR: HTTP status ${response.status()} for ${response.url()}`);
		}
	});
	page.on('console', async msg => {
		try {
			if (msg.type() === 'error' || msg.type() === 'warning') {
				consoleLogFn(msg)(msg.text(), await Promise.all(msg.args().map(async arg => await arg.jsonValue())));
			}
		} catch (err) {
			console.error('Error logging console', err);
		}
	});
	page.on('requestfailed', e => {
		console.error('Request Failed', e.url(), e.failure()?.errorText);
	});

	const host = endpoint.host;
	const protocol = 'vscode-remote';

	const testWorkspacePath = URI.file(path.resolve(optimist.argv.workspacePath)).path;
	const testExtensionUri = url.format({ pathname: URI.file(path.resolve(optimist.argv.extensionDevelopmentPath)).path, protocol, host, slashes: true });
	const testFilesUri = url.format({ pathname: URI.file(path.resolve(optimist.argv.extensionTestsPath)).path, protocol, host, slashes: true });

	const payloadParam = `[["extensionDevelopmentPath","${testExtensionUri}"],["extensionTestsPath","${testFilesUri}"],["enableProposedApi",""],["webviewExternalEndpointCommit","ef65ac1ba57f57f2a3961bfe94aa20481caca4c6"],["skipWelcome","true"]]`;

	if (path.extname(testWorkspacePath) === '.code-workspace') {
		await page.goto(`${endpoint.href}&workspace=${testWorkspacePath}&payload=${payloadParam}`);
	} else {
		await page.goto(`${endpoint.href}&folder=${testWorkspacePath}&payload=${payloadParam}`);
	}

	await page.exposeFunction('codeAutomationLog', (type: string, args: any[]) => {
		console[type](...args);
	});

	await page.exposeFunction('codeAutomationExit', async (code: number) => {
		try {
			await browser.close();
		} catch (error) {
			console.error(`Error when closing browser: ${error}`);
		}

		try {
			await promisify(kill)(server.pid!);
		} catch (error) {
			console.error(`Error when killing server process tree (pid: ${server.pid}): ${error}`);
		}

		process.exit(code);
	});
}

function consoleLogFn(msg: playwright.ConsoleMessage) {
	const type = msg.type();
	const candidate = console[type];
	if (candidate) {
		return candidate;
	}

	if (type === 'warning') {
		return console.warn;
	}

	return console.log;
}

async function launchServer(): Promise<{ endpoint: url.UrlWithStringQuery; server: cp.ChildProcess }> {

	// Ensure a tmp user-data-dir is used for the tests
	const tmpDir = tmp.dirSync({ prefix: 't' });
	const testDataPath = tmpDir.name;
	process.once('exit', () => rimraf.sync(testDataPath));

	const userDataDir = path.join(testDataPath, 'd');

	const env = {
		VSCODE_BROWSER: 'chromium',
		...process.env
	};

	const root = path.join(__dirname, '..', '..', '..', '..');
	const logsPath = path.join(root, '.build', 'logs', 'remote-browser-integration-tests');

	const serverArgs = ['--enable-proposed-api', '--disable-telemetry', '--server-data-dir', userDataDir, '--accept-server-license-terms', '--disable-workspace-trust'];

	let serverLocation: string;
	if (process.env.VSCODE_REMOTE_SERVER_PATH) {
		const { serverApplicationName } = require(path.join(process.env.VSCODE_REMOTE_SERVER_PATH, 'product.json'));
		serverLocation = path.join(process.env.VSCODE_REMOTE_SERVER_PATH, 'bin', `${serverApplicationName}${process.platform === 'win32' ? '.cmd' : ''}`);

		if (optimist.argv.debug) {
			console.log(`Starting built server from '${serverLocation}'`);
		}
	} else {
		serverLocation = path.join(root, `scripts/code-server.${process.platform === 'win32' ? 'bat' : 'sh'}`);
		process.env.VSCODE_DEV = '1';

		if (optimist.argv.debug) {
			console.log(`Starting server out of sources from '${serverLocation}'`);
		}
	}

	console.log(`Storing log files into '${logsPath}'`);
	serverArgs.push('--logsPath', logsPath);

	const stdio: cp.StdioOptions = optimist.argv.debug ? 'pipe' : ['ignore', 'pipe', 'ignore'];

	const serverProcess = cp.spawn(
		serverLocation,
		serverArgs,
		{ env, stdio }
	);

	if (optimist.argv.debug) {
		serverProcess.stderr!.on('data', error => console.log(`Server stderr: ${error}`));
		serverProcess.stdout!.on('data', data => console.log(`Server stdout: ${data}`));
	}

	process.on('exit', () => serverProcess.kill());
	process.on('SIGINT', () => {
		serverProcess.kill();
		process.exit(128 + 2); // https://nodejs.org/docs/v14.16.0/api/process.html#process_signal_events
	});
	process.on('SIGTERM', () => {
		serverProcess.kill();
		process.exit(128 + 15); // https://nodejs.org/docs/v14.16.0/api/process.html#process_signal_events
	});

	return new Promise(c => {
		serverProcess.stdout!.on('data', data => {
			const matches = data.toString('ascii').match(/Web UI available at (.+)/);
			if (matches !== null) {
				c({ endpoint: url.parse(matches[1]), server: serverProcess });
			}
		});
	});
}

launchServer().then(async ({ endpoint, server }) => {
	return runTestsInBrowser(optimist.argv.wsEndpoint, endpoint, server);
}, error => {
	console.error(error);
	process.exit(1);
});