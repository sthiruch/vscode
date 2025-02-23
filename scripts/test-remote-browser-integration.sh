#!/usr/bin/env bash
set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname $(dirname $(realpath "$0")))
else
	ROOT=$(dirname $(dirname $(readlink -f $0)))
fi

cd $ROOT

if [ -z "$VSCODE_REMOTE_SERVER_PATH" ]
then
	echo "Using remote server out of sources for remote browser integration tests"
else
	echo "Using $VSCODE_REMOTE_SERVER_PATH as server path for remote browser integration tests"

	# Run from a built: need to compile all test extensions
	# because we run extension tests from their source folders
	# and the build bundles extensions into .build webpacked
	# yarn gulp	compile-extension:vscode-api-tests \
	# 			compile-extension:markdown-language-features \
	# 			compile-extension:typescript-language-features \
	# 			compile-extension:emmet \
	# 			compile-extension:git \
	# 			compile-extension:ipynb \
	# 			compile-extension:configuration-editing \
	# 			compile-extension-media
fi

if [ ! -e 'test/remote/integration/out/index.js' ];then
	yarn --cwd test/remote/integration compile
	yarn playwright-install
fi

# Tests in the extension host

echo
echo "### API tests (folder)"
echo
node test/remote/integration/out/index.js --workspacePath $ROOT/extensions/vscode-api-tests/testWorkspace --enable-proposed-api=vscode.vscode-api-tests --extensionDevelopmentPath=$ROOT/extensions/vscode-api-tests --extensionTestsPath=$ROOT/extensions/vscode-api-tests/out/singlefolder-tests "$@"

echo
echo "### API tests (workspace)"
echo
node test/remote/integration/out/index.js --workspacePath $ROOT/extensions/vscode-api-tests/testworkspace.code-workspace --enable-proposed-api=vscode.vscode-api-tests --extensionDevelopmentPath=$ROOT/extensions/vscode-api-tests --extensionTestsPath=$ROOT/extensions/vscode-api-tests/out/workspace-tests "$@"

echo
echo "### TypeScript tests"
echo
node test/remote/integration/out/index.js --workspacePath $ROOT/extensions/typescript-language-features/test-workspace --extensionDevelopmentPath=$ROOT/extensions/typescript-language-features --extensionTestsPath=$ROOT/extensions/typescript-language-features/out/test/unit "$@"

echo
echo "### Markdown tests"
echo
node test/remote/integration/out/index.js --workspacePath $ROOT/extensions/markdown-language-features/test-workspace --extensionDevelopmentPath=$ROOT/extensions/markdown-language-features --extensionTestsPath=$ROOT/extensions/markdown-language-features/out/test "$@"

echo
echo "### Emmet tests"
echo
node test/remote/integration/out/index.js --workspacePath $ROOT/extensions/emmet/test-workspace --extensionDevelopmentPath=$ROOT/extensions/emmet --extensionTestsPath=$ROOT/extensions/emmet/out/test "$@"

echo
echo "### Git tests"
echo
node test/remote/integration/out/index.js --workspacePath $(mktemp -d 2>/dev/null) --extensionDevelopmentPath=$ROOT/extensions/git --extensionTestsPath=$ROOT/extensions/git/out/test "$@"

echo
echo "### Ipynb tests"
echo
node test/remote/integration/out/index.js --workspacePath $(mktemp -d 2>/dev/null) --extensionDevelopmentPath=$ROOT/extensions/ipynb --extensionTestsPath=$ROOT/extensions/ipynb/out/test "$@"

echo
echo "### Configuration editing tests"
echo
node test/remote/integration/out/index.js --workspacePath $(mktemp -d 2>/dev/null) --extensionDevelopmentPath=$ROOT/extensions/configuration-editing --extensionTestsPath=$ROOT/extensions/configuration-editing/out/test "$@"

