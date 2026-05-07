const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { deleteFilesInFolder, deleteFolderRecursive, deleteAllArtifacts } = require('./deleteFiles');
const dagRunner = require('./parallelRun/dag-runner');
const sddPostCheck = require('./sddPostCheck');

const {
    specPhase1PromptMap,
    specPhase2PromptMap,
    createDomainPromptMap,
    createApplicationPromptMap,
    createCallgraphPromptMap,
    rdraFiles,
} = require('./settings/rdraConfig');

let grahUrl = 'https://vsa.co.jp/rdratool/graph/v0.96/index.html?clipboard';

/**
 * menu.js から「実行部分」を切り出したアクション実装。
 */
function createMenuAction({ rl, promptUser, waitForEnterThenNext }) {
    function getClipboardCommand(filePath) {
        const platform = process.platform;
        if (platform === 'win32') {
            const windowsPath = filePath.replace(/\//g, '\\');
            return `powershell -Command "Get-Content -Path ${windowsPath} -Encoding UTF8 | Set-Clipboard"`;
        } else if (platform === 'darwin') {
            return `cat "${filePath}" | pbcopy`;
        }
        return null;
    }

    function getBrowserCommand(url) {
        const platform = process.platform;
        if (platform === 'win32') {
            return `powershell -Command "Start-Process ${url}"`;
        } else if (platform === 'darwin') {
            return `open "${url}"`;
        }
        return null;
    }

    function checkAllFilesExistInFolder(fileNames, folderPath) {
        try {
            const normalize = (s) => s.normalize('NFC');
            const filesInDir = fs.readdirSync(folderPath);
            const filesInDirNormalized = filesInDir.map(normalize);
            return fileNames.every((file) => filesInDirNormalized.includes(file));
        } catch (err) {
            console.error(`ディレクトリの読み込みエラー: ${err}`);
            return false;
        }
    }

    function ensureOutputFolders() {
        const dirs = [
            '0_RDRAZeroOne/phase1',
            '0_RDRAZeroOne/phase2',
            '0_RDRAZeroOne/phase3',
            '0_RDRAZeroOne/phase4',
            '1_RDRA',
            '1_RDRA/if',
            '2_RDRASpec',
            '2_RDRASpec/phase1',
            '2_RDRASpec/phase2',
        ];
        dirs.forEach((dir) => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`フォルダーを作成しました: ${dir}`);
            }
        });
    }

    const waitForEnter =
        typeof waitForEnterThenNext === 'function'
            ? waitForEnterThenNext
            : () => {
                  rl.question('続行するにはEnterキーを押してください... (Enter)\n', () => {
                      promptUser();
                  });
              };

    function getProjectRoot() {
        return dagRunner.findProjectRootByInitialRequest(process.cwd());
    }

    /**
     * メニュー1: Phase1〜4 と 1_RDRA を削除し、DAG で一括生成
     */
    function executeFromScratch() {
        ensureOutputFolders();
        const root = getProjectRoot();
        console.log('Phase1〜Phase4、1_RDRA、2_RDRASpec、3_RDRASdd配下を削除します...');
        for (let i = 1; i <= 4; i++) {
            deleteFilesInFolder(`0_RDRAZeroOne/phase${i}`, root);
        }
        deleteFilesInFolder('1_RDRA', root);
        deleteFilesInFolder('2_RDRASpec', root);
        deleteFilesInFolder('3_RDRASdd', root);
        console.log('削除完了。DAG により一括生成します...');
        dagRunner
            .runMenu8(root)
            .then(() => {
                console.log('');
                console.log('処理が完了しました。');
                waitForEnter();
            })
            .catch((err) => {
                console.error(err.message || err);
                waitForEnter();
            });
    }

    /**
     * メニュー7: 未完了の最小フェーズを 1 回だけ実行（従来のフェーズ単位）
     */
    function executeEachPhase() {
        ensureOutputFolders();
        const root = getProjectRoot();
        dagRunner
            .runMenu7(root)
            .then(() => {
                console.log('');
                console.log('処理が完了しました。');
                waitForEnter();
            })
            .catch((err) => {
                console.error(err.message || err);
                waitForEnter();
            });
    }

    /**
     * メニュー8: 依存 DAG に基づき未生成ノードを波状並列実行
     */
    function executeAllPhase() {
        ensureOutputFolders();
        console.log('全フェーズのRDRA定義を行います（DAG 並列）...');
        const root = getProjectRoot();
        dagRunner
            .runMenu8(root)
            .then(() => {
                console.log('');
                console.log('処理が完了しました。');
                waitForEnter();
            })
            .catch((err) => {
                console.error(err.message || err);
                waitForEnter();
            });
    }

    function executeSpec() {
        console.log('仕様の作成を実行します（phase1 → phase2）...');
        const specTimeoutMs = 600000;

        const outputDir = '2_RDRASpec';
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
            console.log(`出力フォルダを作成しました: ${outputDir}`);
        }
        const phase1Dir = '2_RDRASpec/phase1';
        if (!fs.existsSync(phase1Dir)) {
            fs.mkdirSync(phase1Dir, { recursive: true });
            console.log(`出力フォルダを作成しました: ${phase1Dir}`);
        }

        const runParallel = async (promptMap) => {
            const args = promptMap.map((pair) => pair.prompt);
            console.log('実行するプロンプトファイル:');
            promptMap.forEach((pair) => {
                console.log(`  ${pair.prompt}`);
            });
            console.log('');

            try {
                const code = await new Promise((resolve, reject) => {
                    const child = spawn(
                        'node',
                        ['RDRA_Knowledge/helper_tools/parallelRun/parallel-runner.js', ...args, '--timeout', String(specTimeoutMs)],
                        {
                            stdio: 'inherit',
                            shell: true,
                        }
                    );
                    child.on('close', (exitCode) => resolve(exitCode ?? 1));
                    child.on('error', (error) => reject(error));
                });
                return code === 0 ? 0 : 1;
            } catch (error) {
                console.error(`エラー: ${error.message}`);
                return 1;
            }
        };

        (async () => {
            const code1 = await runParallel(specPhase1PromptMap);
            if (code1 !== 0) {
                console.error('仕様(phase1)がエラーで終了しました。');
                waitForEnterThenNext();
                return;
            }
            const code2 = await runParallel(specPhase2PromptMap);
            if (code2 === 0) {
                console.log('');
                console.log('仕様の作成が完了しました。');
            } else {
                console.error('仕様(phase2)がエラーで終了しました。');
            }
            waitForEnterThenNext();
        })();
    }

    function hasSpecBaseInputs() {
        return (
            fs.existsSync('2_RDRASpec/論理データモデル.md') &&
            fs.existsSync('2_RDRASpec/ビジネスルール.md') &&
            fs.existsSync('2_RDRASpec/画面照会.json')
        );
    }

    function runPromptMap(promptMap, label) {
        const specTimeoutMs = 600000;
        console.log(`${label}を実行します...`);

        return (async () => {
            const args = promptMap.map((pair) => pair.prompt);
            console.log('実行するプロンプトファイル:');
            promptMap.forEach((pair) => {
                console.log(`  ${pair.prompt}`);
            });
            console.log('');

            try {
                const code = await new Promise((resolve, reject) => {
                    const child = spawn(
                        'node',
                        ['RDRA_Knowledge/helper_tools/parallelRun/parallel-runner.js', ...args, '--timeout', String(specTimeoutMs)],
                        {
                            stdio: 'inherit',
                            shell: true,
                        }
                    );
                    child.on('close', (exitCode) => resolve(exitCode ?? 1));
                    child.on('error', (error) => reject(error));
                });
                return code === 0 ? 0 : 1;
            } catch (error) {
                console.error(`エラー: ${error.message}`);
                return 1;
            }
        })();
    }

    /**
     * BUC 単位 UI 生成用にプロンプト先頭へ付与するブロック（parallel-runner の buildContextHeader に続けて解釈される）
     * @param {string} projectRoot
     * @param {string} bucEnglishName
     * @returns {string}
     */
    function buildUiBucContextBlock(projectRoot, bucEnglishName) {
        void projectRoot;
        const appRel = `3_RDRASdd/application/${bucEnglishName}.md`;
        return [
            '# BUC 単位実行コンテキスト（自動付与）',
            '',
            `- **TARGET_BUC（英語名）**: ${bucEnglishName}`,
            `- **入力 Application 仕様**: \`${appRel}\``,
            `- **出力先ディレクトリ**: \`3_RDRASdd/ui/${bucEnglishName}/\``,
            `- 今回は **この BUC に属する画面だけ** を生成する。**他 BUC のフォルダーや画面ファイルは作成・変更・削除しない。**`,
            `- \`${appRel}\` の「利用画面」に列挙された画面数と、\`3_RDRASdd/ui/${bucEnglishName}/\` の本体 \`.md\` 件数（先頭 \`_\` 以外、サブフォルダ含む）が一致するまで完了を宣言しない。`,
            '',
            '---',
            '',
            '',
        ].join('\n');
    }

    /**
     * `33_Create_UI.md` に BUC コンテキストを前置した一時プロンプトを `3_RDRASdd/_ui_prompt_work/` に書き出す。
     * @param {string} projectRoot
     * @param {string} bucEnglishName
     * @returns {string} プロジェクトルート相対パス（POSIX 区切り）
     */
    function writeCombinedUiPromptForBuc(projectRoot, bucEnglishName) {
        const srcAbs = path.join(projectRoot, 'RDRA_Knowledge', '_3_RDRASdd', '33_Create_UI.md');
        const workDir = path.join(projectRoot, '3_RDRASdd', '_ui_prompt_work');
        if (!fs.existsSync(workDir)) {
            fs.mkdirSync(workDir, { recursive: true });
        }
        if (!fs.existsSync(srcAbs)) {
            throw new Error(`UI プロンプトが見つかりません: ${srcAbs}`);
        }
        const base = fs.readFileSync(srcAbs, 'utf8');
        const combined = buildUiBucContextBlock(projectRoot, bucEnglishName) + base;
        const outAbs = path.join(workDir, `33_Create_UI__${bucEnglishName}.md`);
        fs.writeFileSync(outAbs, combined, 'utf8');
        return path.relative(projectRoot, outAbs).split(path.sep).join('/');
    }

    /**
     * @param {string} projectRoot
     * @returns {string[]} `CareFooFlow.md` のようなファイル名（拡張子付き）をソート済みで返す
     */
    function listApplicationMdFiles(projectRoot) {
        const appDir = path.join(projectRoot, '3_RDRASdd', 'application');
        if (!fs.existsSync(appDir)) return [];
        return fs
            .readdirSync(appDir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
            .map((e) => e.name)
            .sort();
    }

    /**
     * @param {string[]} promptRelPaths - プロジェクトルート相対のプロンプトファイルパス
     * @param {string} label
     * @returns {Promise<number>} 成功時 0
     */
    function runPromptPaths(promptRelPaths, label) {
        const specTimeoutMs = 600000;
        console.log(`${label}を実行します...`);

        return (async () => {
            console.log('実行するプロンプトファイル:');
            promptRelPaths.forEach((p) => console.log(`  ${p}`));
            console.log('');

            try {
                const code = await new Promise((resolve, reject) => {
                    const child = spawn(
                        'node',
                        ['RDRA_Knowledge/helper_tools/parallelRun/parallel-runner.js', ...promptRelPaths, '--timeout', String(specTimeoutMs)],
                        {
                            stdio: 'inherit',
                            shell: true,
                        }
                    );
                    child.on('close', (exitCode) => resolve(exitCode ?? 1));
                    child.on('error', (error) => reject(error));
                });
                return code === 0 ? 0 : 1;
            } catch (error) {
                console.error(`エラー: ${error.message}`);
                return 1;
            }
        })();
    }

    /**
     * domain / application / ui の部分 JSON を統合して 3_RDRASdd/_callgraph/callgraph_data.json を生成する。
     * @returns {Promise<number>} 成功時 0、失敗時 1
     */
    function runMergeCallgraphData() {
        return new Promise((resolve, reject) => {
            const root = getProjectRoot();
            const child = spawn(
                'node',
                ['RDRA_Knowledge/helper_tools/mergeCallgraphData.js'],
                {
                    stdio: 'inherit',
                    shell: true,
                    cwd: root,
                }
            );
            child.on('close', (exitCode) => resolve(exitCode === 0 ? 0 : 1));
            child.on('error', (error) => reject(error));
        });
    }

    /**
     * `3_RDRASdd/ui` 配下の .md ファイル数（再帰）。
     * @param {string} dir
     * @returns {number}
     */
    function countMarkdownFilesRecursive(dir) {
        if (!fs.existsSync(dir)) return 0;
        let n = 0;
        function walk(d) {
            let entries;
            try {
                entries = fs.readdirSync(d, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) n += 1;
            }
        }
        walk(dir);
        return n;
    }

    /**
     * Callgraph 用の3つの部分 JSON が生成済みか検証する（mergeCallgraphData.js 実行前）。
     * @returns {{ ok: boolean, errors: string[] }}
     */
    function validateCallgraphPartialJsons() {
        const errors = [];
        const checks = [
            {
                rel: '3_RDRASdd/_callgraph/callgraph_domain_data.json',
                label: 'domain',
                validate: (obj) => {
                    if (!Array.isArray(obj.contexts) || !Array.isArray(obj.services) || !Array.isArray(obj.entities)) {
                        return 'contexts / services / entities は配列である必要があります。';
                    }
                    return null;
                },
            },
            {
                rel: '3_RDRASdd/_callgraph/callgraph_application_data.json',
                label: 'application',
                validate: (obj) => {
                    if (!Array.isArray(obj.appBucs) || !Array.isArray(obj.ucs)) {
                        return 'appBucs / ucs は配列である必要があります。';
                    }
                    return null;
                },
            },
            {
                rel: '3_RDRASdd/_callgraph/callgraph_ui_data.json',
                label: 'ui',
                validate: (obj) => {
                    if (!Array.isArray(obj.uiBucs) || !Array.isArray(obj.screens)) {
                        return 'uiBucs / screens は配列である必要があります。';
                    }
                    const uiMdCount = countMarkdownFilesRecursive('3_RDRASdd/ui');
                    if (uiMdCount > 0 && obj.screens.length === 0) {
                        return `3_RDRASdd/ui に .md が ${uiMdCount} 件あるのに screens が空です。`;
                    }
                    return null;
                },
            },
        ];

        for (const c of checks) {
            if (!fs.existsSync(c.rel)) {
                errors.push(
                    `部分的な JSON がありません: ${c.rel}（${c.label}）。対応する callgraph_${c.label}_data_maker.md がファイルを出力しなかった可能性があります。parallel-runner の該当ログを確認してください。`
                );
                continue;
            }
            let obj;
            try {
                obj = JSON.parse(fs.readFileSync(c.rel, 'utf8'));
            } catch (e) {
                errors.push(`${c.rel}: JSON として読めません (${e.message || e})`);
                continue;
            }
            const msg = c.validate(obj);
            if (msg) errors.push(`${c.rel}: ${msg}`);
        }

        return { ok: errors.length === 0, errors };
    }

    function executePromptMap(promptMap, label, postCheck) {
        (async () => {
            const code = await runPromptMap(promptMap, label);
            if (code === 0) {
                console.log('');
                console.log(`${label}が完了しました。`);
                if (typeof postCheck === 'function') {
                    try {
                        postCheck();
                    } catch (e) {
                        console.warn(`[SDD事後チェック] 例外: ${e.message || e}`);
                    }
                }
            } else {
                console.error(`${label}がエラーで終了しました。`);
            }
            waitForEnter();
        })();
    }

    function ensureRdraFuncFolders() {
        const dirs = ['3_RDRASdd/domain', '3_RDRASdd/application', '3_RDRASdd/ui'];
        dirs.forEach((dir) => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`フォルダーを作成しました: ${dir}`);
            }
        });
    }

    function deleteRdraFuncFoldersBefore(folders) {
        const root = getProjectRoot();
        folders.forEach((folder) => deleteFolderRecursive(folder, root));
    }

    function showRDRAGraph() {
        console.log('関連データを作成しています...');
        exec('node RDRA_Knowledge/helper_tools/makeGraphData.js', (error) => {
            if (error) {
                console.error(`エラー: ${error}`);
                promptUser();
                return;
            }
            console.log('関連データの作成が完了しました。');
            console.log('RDRAGraphを表示しています...');

            const clipboardCmd = getClipboardCommand('1_RDRA/if/関連データ.txt');
            const browserCmd = getBrowserCommand(grahUrl);

            if (!clipboardCmd || !browserCmd) {
                console.error('このOSではクリップボード操作またはブラウザ起動がサポートされていません。');
                promptUser();
                return;
            }

            exec(clipboardCmd, (clipError) => {
                if (clipError) {
                    console.error(`クリップボードエラー: ${clipError}`);
                } else {
                    console.log('データをクリップボードにコピーしました。');
                    exec(browserCmd, (browserError) => {
                        if (browserError) {
                            console.error(`ブラウザ起動エラー: ${browserError}`);
                        } else {
                            console.log('ブラウザでRDRAGraphを開きました。');
                        }
                        promptUser();
                    });
                }
            });
        });
    }

    function makeZeroOneData() {
        console.log('ZeroOneデータをクリップボードにコピーします...');
        exec('node RDRA_Knowledge/helper_tools/makeZeroOneData.js', (error, stdout, stderr) => {
            if (error) {
                console.error(`エラー: ${error}`);
                promptUser();
                return;
            }
            if (stdout) console.log(stdout);
            if (stderr) console.error(stderr);
            console.log('ZeroOneデータの処理が完了しました。');

            exec('node RDRA_Knowledge/helper_tools/copyToClipboard.js zeroone', (error2, stdout2, stderr2) => {
                if (error2) {
                    console.error(`エラー: ${error2}`);
                    promptUser();
                    return;
                }
                if (stdout2) console.log(stdout2);
                if (stderr2) console.error(stderr2);
                console.log('データはクリップボードにコピーされました。スプレッドシートに貼り付けてください。');

                const browserCmd = getBrowserCommand(
                    'https://docs.google.com/spreadsheets/d/1h7J70l6DyXcuG0FKYqIpXXfdvsaqjdVFwc6jQXSh9fM/edit?gid=1240873646#gid=1240873646'
                );
                if (browserCmd) {
                    exec(browserCmd, (browserError) => {
                        if (browserError) {
                            console.error(`ブラウザ起動エラー: ${browserError}`);
                        } else {
                            console.log('スプレッドシートをブラウザで開きました。');
                        }
                        promptUser();
                    });
                } else {
                    promptUser();
                }
            });
        });
    }

    function showActorUI() {
        console.log('画面照会（BUC/アクター）を表示する');
        if (!fs.existsSync('2_RDRASpec/画面照会.json') && !fs.existsSync('2_RDRASpec/ui.json')) {
            console.error('エラー: 2_RDRASpec/画面照会.json（または ui.json）が存在しません。');
            console.error('先にメニュー21で仕様ファイルを作成してください。');
            promptUser();
            return;
        }

        const existingServer = global.bucActorUIServer;
        const isServerRunning = existingServer && existingServer.exitCode === null && !existingServer.killed;

        if (isServerRunning) {
            console.log('サーバーは既に起動しています。ブラウザで画面を開きます...');
            const browserCmd = getBrowserCommand('http://localhost:3002/');
            if (browserCmd) {
                exec(browserCmd, (browserError) => {
                    if (browserError) console.error(`ブラウザ起動エラー: ${browserError}`);
                });
            }
            console.log('画面照会（BUC/アクター）を表示しました。');
            promptUser();
            return;
        }

        if (existingServer && !isServerRunning) {
            global.bucActorUIServer = null;
        }

        console.log('HTTPサーバーを起動してブラウザで画面を開きます...');
        const serverProcess = spawn('node', ['RDRA_Knowledge/helper_tools/web_tool/bucActorUI.js'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
        });

        let serverStarted = false;
        serverProcess.stdout.on('data', (data) => {
            console.log(`${data}`);
            if (!serverStarted && data.toString().includes('簡易HTTPサーバーが起動しました')) {
                serverStarted = true;
                setTimeout(() => {
                    const browserCmd = getBrowserCommand('http://localhost:3002/');
                    if (browserCmd) {
                        exec(browserCmd, (browserError) => {
                            if (browserError) console.error(`ブラウザ起動エラー: ${browserError}`);
                        });
                    }
                }, 500);
            }
        });
        serverProcess.stderr.on('data', (data) => {
            console.error(`${data}`);
        });
        serverProcess.on('error', (error) => {
            console.error(`サーバー起動エラー: ${error}`);
        });
        serverProcess.on('close', () => {
            console.log('画面照会（BUC/アクター）サーバーが終了しました。');
            global.bucActorUIServer = null;
        });
        global.bucActorUIServer = serverProcess;
        console.log('画面照会（BUC/アクター）を表示しました。');
        console.log('画面の「閉じる」ボタン、またはタブ/ブラウザを閉じると自動でサーバーが停止します。');
        promptUser();
    }

    function showCallgraphUI() {
        console.log('Callgraphを表示する');
        const hasRdraFuncOutputs =
            fs.existsSync('3_RDRASdd/domain') &&
            fs.existsSync('3_RDRASdd/application') &&
            fs.existsSync('3_RDRASdd/ui');
        if (!hasRdraFuncOutputs) {
            console.error('エラー: 3_RDRASdd/domain, 3_RDRASdd/application, 3_RDRASdd/ui が不足しています。');
            console.error('先にメニュー31〜33で機能仕様を作成してください。');
            promptUser();
            return;
        }

        const existingServer = global.callgraphServer;
        const isServerRunning = existingServer && existingServer.exitCode === null && !existingServer.killed;
        const callgraphUrl = 'http://127.0.0.1:3000/callgraph.html';
        if (isServerRunning) {
            console.log('Callgraphサーバーは既に起動しています。ブラウザで画面を開きます...');
            const browserCmd = getBrowserCommand(callgraphUrl);
            if (browserCmd) {
                exec(browserCmd, (browserError) => {
                    if (browserError) console.error(`ブラウザ起動エラー: ${browserError}`);
                });
            }
            promptUser();
            return;
        }
        if (existingServer && !isServerRunning) {
            global.callgraphServer = null;
        }

        const serverProcess = spawn('node', ['RDRA_Knowledge/helper_tools/web_tool/callgraph_server.js'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
        });
        let serverStarted = false;
        serverProcess.stdout.on('data', (data) => {
            const text = data.toString();
            console.log(text);
            if (!serverStarted && text.includes('callgraph_server: listening on ')) {
                serverStarted = true;
                setTimeout(() => {
                    const browserCmd = getBrowserCommand(callgraphUrl);
                    if (browserCmd) {
                        exec(browserCmd, (browserError) => {
                            if (browserError) console.error(`ブラウザ起動エラー: ${browserError}`);
                        });
                    }
                }, 500);
            }
        });
        serverProcess.stderr.on('data', (data) => {
            console.error(`${data}`);
        });
        serverProcess.on('error', (error) => {
            console.error(`サーバー起動エラー: ${error}`);
        });
        serverProcess.on('close', () => {
            console.log('Callgraphサーバーが終了しました。');
            global.callgraphServer = null;
        });
        global.callgraphServer = serverProcess;
        console.log('Callgraphサーバーを起動しました。');
        console.log('画面の「閉じる」ボタンでサーバーを停止できます。');
        promptUser();
    }

    function deleteGeneratedFiles() {
        console.log('生成された成果物を削除しています...');
        try {
            deleteAllArtifacts(getProjectRoot());
            console.log('成果物の削除が完了しました。');
        } catch (e) {
            console.error(`エラー: ${e.message || e}`);
        }
        promptUser();
    }

    function exitProgram() {
        console.log('プログラムを終了します。');
        if (global.bucActorUIServer) {
            global.bucActorUIServer.kill('SIGTERM');
        }
        if (global.callgraphServer) {
            global.callgraphServer.kill('SIGTERM');
        }
        rl.close();
        process.exit(0);
    }

    function executeOption(option) {
        switch (option) {
            case '1':
                executeFromScratch();
                break;
            case '2':
                executeEachPhase();
                break;
            case '3':
                executeAllPhase();
                break;
            case '11':
                if (checkAllFilesExistInFolder(rdraFiles, '1_RDRA')) {
                    console.log('RDRAGraphを表示する。');
                    showRDRAGraph();
                } else {
                    console.log('1_RDRAフォルダーにRDRA定義が生成されていません。');
                    waitForEnter();
                }
                break;
            case '12':
                if (checkAllFilesExistInFolder(rdraFiles, '1_RDRA')) {
                    console.log('ZeroOneデータをクリップボードにコピーします...');
                    makeZeroOneData();
                } else {
                    console.log('1_RDRAフォルダーにRDRA定義が生成されていません。');
                    waitForEnter();
                }
                break;
            case '21':
                if (checkAllFilesExistInFolder(rdraFiles, '1_RDRA') && fs.existsSync('1_RDRA/if/関連データ.txt')) {
                    executeSpec();
                } else {
                    console.log(
                        '1_RDRA または 1_RDRA/if/関連データ.txt が不足しています。先にRDRA定義を生成し、メニュー11で関連データを作成してください。'
                    );
                    waitForEnter();
                }
                break;
            case '22': {
                const hasSpecPhase1Outputs =
                    fs.existsSync('2_RDRASpec/論理データモデル.md') && fs.existsSync('2_RDRASpec/ビジネスルール.md');
                const hasScreenJson =
                    fs.existsSync('2_RDRASpec/画面照会.json') || fs.existsSync('2_RDRASpec/ui.json');
                if (hasSpecPhase1Outputs && hasScreenJson) {
                    console.log('画面照会（BUC/アクター）を表示する。');
                    showActorUI();
                } else {
                    console.log('2_RDRASpecフォルダーに仕様ファイルが生成されていません。');
                    console.log('必要ファイル: 論理データモデル.md / ビジネスルール.md / 画面照会.json');
                    waitForEnter();
                }
                break;
            }
            case '31':
                if (checkAllFilesExistInFolder(rdraFiles, '1_RDRA') && fs.existsSync('1_RDRA/if/関連データ.txt') && hasSpecBaseInputs()) {
                    deleteRdraFuncFoldersBefore(['3_RDRASdd/domain', '3_RDRASdd/application', '3_RDRASdd/ui']);
                    ensureRdraFuncFolders();
                    executePromptMap(createDomainPromptMap, 'ドメイン仕様書の作成', () =>
                        sddPostCheck.reportDomain(getProjectRoot())
                    );
                } else {
                    console.log(
                        '実行に必要なファイルが不足しています。必要ファイル: 1_RDRA/*, 1_RDRA/if/関連データ.txt, 2_RDRASpec/論理データモデル.md, 2_RDRASpec/ビジネスルール.md, 2_RDRASpec/画面照会.json'
                    );
                    waitForEnter();
                }
                break;
            case '32':
                if (checkAllFilesExistInFolder(rdraFiles, '1_RDRA') && fs.existsSync('1_RDRA/if/関連データ.txt') && hasSpecBaseInputs()) {
                    deleteRdraFuncFoldersBefore(['3_RDRASdd/application', '3_RDRASdd/ui']);
                    ensureRdraFuncFolders();
                    executePromptMap(createApplicationPromptMap, 'アプリケーション仕様書の作成', () =>
                        sddPostCheck.reportApplication(getProjectRoot())
                    );
                } else {
                    console.log(
                        '実行に必要なファイルが不足しています。必要ファイル: 1_RDRA/*, 1_RDRA/if/関連データ.txt, 2_RDRASpec/論理データモデル.md, 2_RDRASpec/ビジネスルール.md, 2_RDRASpec/画面照会.json'
                    );
                    waitForEnter();
                }
                break;
            case '33':
                if (checkAllFilesExistInFolder(rdraFiles, '1_RDRA') && fs.existsSync('1_RDRA/if/関連データ.txt') && hasSpecBaseInputs()) {
                    deleteRdraFuncFoldersBefore(['3_RDRASdd/ui']);
                    ensureRdraFuncFolders();
                    (async () => {
                        const root = getProjectRoot();
                        const appFiles = listApplicationMdFiles(root);
                        if (appFiles.length === 0) {
                            console.error('エラー: 3_RDRASdd/application に .md がありません。先にメニュー32でアプリケーション仕様を作成してください。');
                            waitForEnter();
                            return;
                        }
                        for (const appFile of appFiles) {
                            const bucEnglishName = path.basename(appFile, '.md');
                            let promptRel;
                            try {
                                promptRel = writeCombinedUiPromptForBuc(root, bucEnglishName);
                            } catch (e) {
                                console.error(`エラー: ${e.message || e}`);
                                waitForEnter();
                                return;
                            }
                            const uiCode = await runPromptPaths([promptRel], `UI仕様書の作成 (${bucEnglishName})`);
                            if (uiCode !== 0) {
                                console.error(`UI仕様書の作成がエラーで終了しました（BUC: ${bucEnglishName}）。`);
                                waitForEnter();
                                return;
                            }
                            const bucCheck = sddPostCheck.checkUIBuc(root, bucEnglishName);
                            if (!bucCheck.ok) {
                                console.error(
                                    `UI仕様書の件数が一致しません（BUC: ${bucEnglishName}）。期待=${bucCheck.expected}, 実際=${bucCheck.actual}, 不足≈${bucCheck.missingCount}`
                                );
                                if (bucCheck.underscoreFiles.length > 0) {
                                    console.error(`  先頭 _ の .md が ${bucCheck.underscoreFiles.length} 件あります（中間ファイル禁止）。`);
                                }
                                console.error('Callgraphデータ生成を中止します。該当 BUC の 33_Create_UI 実行ログを確認してください。');
                                waitForEnter();
                                return;
                            }
                        }
                        console.log('');
                        console.log('全 BUC の UI 仕様書の作成が完了しました。');
                        try {
                            sddPostCheck.reportUI(root);
                        } catch (e) {
                            console.warn(`[SDD事後チェック] reportUI 例外: ${e.message || e}`);
                        }
                        const uiCheck = sddPostCheck.checkUI(root);
                        if (!uiCheck.ok) {
                            if (uiCheck.error) {
                                console.error(`[SDD事後チェック] ${uiCheck.error}`);
                            } else {
                                console.error(
                                    `UI仕様書の出力件数が不足しています: expected=${uiCheck.expected}, actual=${uiCheck.actual}, 不足≈${uiCheck.missingCount}`
                                );
                            }
                            if (uiCheck.underscoreFiles.length > 0) {
                                console.error(`  先頭 _ の .md が ${uiCheck.underscoreFiles.length} 件あります。`);
                            }
                            console.error('Callgraphデータ生成を中止します。33_Create_UI.md の出力ログを確認してください。');
                            waitForEnter();
                            return;
                        }
                        try {
                            sddPostCheck.reportApiUiAlignment(root);
                        } catch (e) {
                            console.warn(`[SDD事後チェック] reportApiUiAlignment 例外: ${e.message || e}`);
                        }
                        console.log('');
                        console.log('Callgraphデータを生成します...');
                        const callgraphCode = await runPromptMap(createCallgraphPromptMap, 'Callgraphデータの作成');
                        if (callgraphCode !== 0) {
                            console.error('Callgraphデータの作成がエラーで終了しました。');
                            waitForEnter();
                            return;
                        }
                        const partialCheck = validateCallgraphPartialJsons();
                        if (!partialCheck.ok) {
                            console.error('Callgraph 部分 JSON の検証に失敗しました:');
                            partialCheck.errors.forEach((err) => console.error(`  - ${err}`));
                            console.error(
                                'AI が確認質問のみで終了しファイルを書いていない可能性があります。該当の callgraph_*_data_maker.md を単体再実行するか、プロンプト冒頭の実行モードを確認してください。'
                            );
                            waitForEnter();
                            return;
                        }
                        console.log('');
                        console.log('部分 JSON を統合して callgraph_data.json を生成します...');
                        let mergeCode;
                        try {
                            mergeCode = await runMergeCallgraphData();
                        } catch (e) {
                            console.error(`Callgraph 統合エラー: ${e.message || e}`);
                            waitForEnter();
                            return;
                        }
                        if (mergeCode !== 0) {
                            console.error(
                                'Callgraph データの統合に失敗しました。3_RDRASdd の部分 JSON と mergeCallgraphData.js を確認してください。'
                            );
                            waitForEnter();
                            return;
                        }
                        console.log('');
                        console.log('Callgraphデータの作成が完了しました。');
                        waitForEnter();
                    })();
                } else {
                    console.log(
                        '実行に必要なファイルが不足しています。必要ファイル: 1_RDRA/*, 1_RDRA/if/関連データ.txt, 2_RDRASpec/論理データモデル.md, 2_RDRASpec/ビジネスルール.md, 2_RDRASpec/画面照会.json'
                    );
                    waitForEnter();
                }
                break;
            case '34':
                (async () => {
                    const hasRdraFuncOutputs =
                        fs.existsSync('3_RDRASdd/domain') &&
                        fs.existsSync('3_RDRASdd/application') &&
                        fs.existsSync('3_RDRASdd/ui');
                    if (!hasRdraFuncOutputs) {
                        console.error('エラー: 3_RDRASdd/domain, 3_RDRASdd/application, 3_RDRASdd/ui が不足しています。');
                        console.error('先にメニュー31〜33で機能仕様を作成してください。');
                        waitForEnter();
                        return;
                    }
                    const callgraphDataPath = '3_RDRASdd/_callgraph/callgraph_data.json';
                    if (!fs.existsSync(callgraphDataPath)) {
                        console.log('');
                        console.log('callgraph_data.json が無いため、Callgraphデータを生成します...');
                        const code = await runPromptMap(createCallgraphPromptMap, 'Callgraphデータの作成');
                        if (code !== 0) {
                            console.error('Callgraphデータの作成がエラーで終了しました。');
                            waitForEnter();
                            return;
                        }
                        const partialCheck = validateCallgraphPartialJsons();
                        if (!partialCheck.ok) {
                            console.error('Callgraph 部分 JSON の検証に失敗しました:');
                            partialCheck.errors.forEach((err) => console.error(`  - ${err}`));
                            console.error(
                                'AI が確認質問のみで終了しファイルを書いていない可能性があります。該当の callgraph_*_data_maker.md を単体再実行するか、プロンプト冒頭の実行モードを確認してください。'
                            );
                            waitForEnter();
                            return;
                        }
                        console.log('');
                        console.log('部分 JSON を統合して callgraph_data.json を生成します...');
                        let mergeCode;
                        try {
                            mergeCode = await runMergeCallgraphData();
                        } catch (e) {
                            console.error(`Callgraph 統合エラー: ${e.message || e}`);
                            waitForEnter();
                            return;
                        }
                        if (mergeCode !== 0) {
                            console.error(
                                'Callgraph データの統合に失敗しました。3_RDRASdd の部分 JSON と mergeCallgraphData.js を確認してください。'
                            );
                            waitForEnter();
                            return;
                        }
                        console.log('');
                        console.log('Callgraphデータの作成が完了しました。');
                        if (!fs.existsSync(callgraphDataPath)) {
                            console.warn(
                                '警告: Callgraphデータ作成後も callgraph_data.json が見つかりません。ブラウザで読み込みに失敗する可能性があります。'
                            );
                        }
                    }
                    showCallgraphUI();
                })();
                break;
            case '0':
                exitProgram();
                break;
            case '99':
                deleteGeneratedFiles();
                break;
            default:
                console.log('無効な選択肢です。選択肢の番号を入力してください。');
                promptUser();
                break;
        }
    }

    return executeOption;
}

module.exports = { createMenuAction };
