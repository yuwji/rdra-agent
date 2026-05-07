/**
 * AI Runner (library)
 * - parallel-runner.js から利用されることを想定した最小実装
 * - 単体CLIとしての実行はサポートしない（不要機能を削除）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 360000;

// ========================================
// 設定ファイル（モデル設定.json）読み込み
// - 「初期要望.txt」と同じフォルダをプロジェクトルートとみなす
// - モデル設定.json も同フォルダに置く
// ========================================
function findProjectRootByInitialRequest(startDir) {
    let dir = path.resolve(startDir);
    const { root } = path.parse(dir);

    while (true) {
        const marker = path.join(dir, '初期要望.txt');
        if (fs.existsSync(marker)) {
            return dir;
        }
        if (dir === root) {
            throw new Error('初期要望.txt が見つからず、プロジェクトルートを特定できません');
        }
        dir = path.dirname(dir);
    }
}

function getModelConfigPath() {
    const projectRoot = findProjectRootByInitialRequest(__dirname);
    return path.join(projectRoot, 'モデル設定.json');
}

function loadModelConfig() {
    const configPath = getModelConfigPath();
    if (!fs.existsSync(configPath)) {
        throw new Error(`モデル設定ファイルが見つかりません: ${configPath}`);
    }

    try {
        const jsonText = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(jsonText);
        return parsed;
    } catch (e) {
        throw new Error(`モデル設定ファイルの読み込みに失敗しました: ${e.message}\npath: ${configPath}`);
    }
}

function assertObject(name, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`モデル設定の形式エラー: ${name} は object である必要があります`);
    }
}

function isTruthyConfigValue(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return !Number.isNaN(v);
    if (typeof v === 'string') return v.trim().length > 0;
    // object/array は存在していれば true 扱い（必要なら厳格化）
    return true;
}

function templateReplace(token, vars) {
    return token.replace(/\{([A-Za-z0-9_-]+)\}/g, (_m, key) => {
        if (!(key in vars)) {
            throw new Error(`モデル設定のテンプレート解決に失敗: {${key}} が未定義です`);
        }
        const v = vars[key];
        if (v === undefined || v === null) return '';
        return String(v);
    });
}

function buildArgsFromTemplate(providerConfig, prompt, runtimeOptions) {
    const providerVars = (providerConfig.vars && typeof providerConfig.vars === 'object')
        ? providerConfig.vars
        : {};

    const vars = {
        ...providerVars,
        prompt,
        ...(runtimeOptions || {}),
    };

    const args = [];

    const baseArgs = Array.isArray(providerConfig.args) ? providerConfig.args : [];
    for (const t of baseArgs) {
        if (typeof t !== 'string') {
            throw new Error('モデル設定の形式エラー: args は string の配列である必要があります');
        }
        args.push(templateReplace(t, vars));
    }

    const argsIf = providerConfig.argsIf || {};
    if (argsIf !== null && argsIf !== undefined) {
        assertObject('providers.<name>.argsIf', argsIf);
        for (const [k, templArr] of Object.entries(argsIf)) {
            if (!Array.isArray(templArr)) {
                throw new Error('モデル設定の形式エラー: argsIf の値は string 配列である必要があります');
            }
            if (!isTruthyConfigValue(vars[k])) continue;
            for (const t of templArr) {
                if (typeof t !== 'string') {
                    throw new Error('モデル設定の形式エラー: argsIf の配列要素は string である必要があります');
                }
                args.push(templateReplace(t, vars));
            }
        }
    }

    return args;
}

const MODEL_CONFIG = loadModelConfig();
assertObject('モデル設定', MODEL_CONFIG);
assertObject('default', MODEL_CONFIG.default);
assertObject('providers', MODEL_CONFIG.providers);

const DEFAULT_PROVIDER = String(MODEL_CONFIG.default.provider || '').toLowerCase().trim();
if (!DEFAULT_PROVIDER) {
    throw new Error('モデル設定の形式エラー: default.provider が必要です');
}

function getAvailableProviders() {
    return Object.keys(MODEL_CONFIG.providers);
}

function getResolvedDefaultProvider() {
    return DEFAULT_PROVIDER;
}

// ========================================
// プレフィックス付きリアルタイム出力でAI実行（並行実行対応）
// ========================================
async function runAIWithPrefix(prompt, options = {}) {
    // provider/model はCLIから受け付けない方針のため、設定から決定
    const providerName = DEFAULT_PROVIDER;
    const provider = MODEL_CONFIG.providers[providerName];

    if (!provider) {
        throw new Error(`不明なプロバイダー: ${providerName}\n利用可能: ${getAvailableProviders().join(', ')}`);
    }

    // プレフィックス設定（並行実行時の識別用）
    const prefix = options.prefix || '';
    const prefixStr = prefix ? `[${prefix}] ` : '';

    return new Promise((resolve, reject) => {
        let effectivePrompt = prompt;

        const useStdin = provider.useStdin === true;
        const promptForArgs = useStdin ? '' : effectivePrompt;
        let args = buildArgsFromTemplate(provider, promptForArgs, options);

        process.stdout.write(`${prefixStr}---\n`);

        const command = provider.command;
        if (!command || typeof command !== 'string') {
            throw new Error(`モデル設定の形式エラー: providers.${providerName}.command が不正です`);
        }

        let spawnCommand = command;
        let spawnArgs = args;
        let spawnOptions = {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32', // Windows のみ shell 経由（Unix では argv 安全のため shell:false）
            env: {
                ...process.env,
                ...(provider.env && typeof provider.env === 'object' ? provider.env : {}),
            },
        };

        // Windows の cline は shell:true で複数行プロンプトを位置引数に渡すと
        // 先頭行だけに切り詰められるため、PowerShell 経由で 1 つの文字列として渡す。
        if (process.platform === 'win32' && command.toLowerCase() === 'cline' && !useStdin) {
            const argsWithoutPrompt = buildArgsFromTemplate(provider, '', options);
            const promptB64 = Buffer.from(effectivePrompt, 'utf8').toString('base64');
            const argsB64 = Buffer.from(JSON.stringify(argsWithoutPrompt), 'utf8').toString('base64');
            const psScript =
                `$prompt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${promptB64}')); ` +
                `$argsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${argsB64}')); ` +
                `$clineArgs = @(); ` +
                `if ($argsJson -and $argsJson -ne '[]') { $clineArgs = @((ConvertFrom-Json $argsJson)) }; ` +
                `& cline @clineArgs $prompt`;

            spawnCommand = 'powershell';
            spawnArgs = ['-NoProfile', '-Command', psScript];
            spawnOptions = {
                ...spawnOptions,
                shell: false,
            };
        }

        const child = spawn(spawnCommand, spawnArgs, spawnOptions);

        let stdout = '';
        let stderr = '';
        let needsPrefix = true;
        let needsPrefixErr = true;

        const timeout = setTimeout(() => {
            process.stdout.write(`\n${prefixStr}⏰ タイムアウト\n`);
            child.kill();
            reject(new Error('タイムアウト'));
        }, options.timeout || DEFAULT_TIMEOUT_MS);

        const outputRealtime = (data) => {
            const text = data.toString();
            stdout += text;

            // 文字単位で処理し、改行後にプレフィックスを挿入
            let output = '';
            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                if (needsPrefix) {
                    output += prefixStr;
                    needsPrefix = false;
                }
                output += char;
                if (char === '\n') {
                    needsPrefix = true;
                }
            }
            process.stdout.write(output);
        };

        const errorRealtime = (data) => {
            const text = data.toString();
            stderr += text;

            // 文字単位で処理し、改行後にプレフィックスを挿入
            let output = '';
            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                if (needsPrefixErr) {
                    output += `${prefixStr}[stderr] `;
                    needsPrefixErr = false;
                }
                output += char;
                if (char === '\n') {
                    needsPrefixErr = true;
                }
            }
            process.stderr.write(output);
        };

        child.stdout.on('data', outputRealtime);

        // stderrは常にリアルタイム出力（並行実行でも識別できるようprefix付与）
        child.stderr.on('data', errorRealtime);

        child.on('close', (code) => {
            clearTimeout(timeout);

            if (!needsPrefix) {
                process.stdout.write('\n');
            }

            if (code === 0) {
                resolve({ stdout, stderr, code, provider: providerName });
            } else {
                if (stderr) {
                    process.stderr.write(`${prefixStr}エラー出力: ${stderr}\n`);
                }
                reject(new Error(`終了コード ${code}`));
            }
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`${prefixStr}実行エラー: ${err.message}`));
        });

        // stdin経由でプロンプトを渡す場合
        if (useStdin) {
            child.stdin.write(effectivePrompt);
            child.stdin.end();
        }
    });
}

module.exports = {
    runAIWithPrefix,
    DEFAULT_PROVIDER,
    getAvailableProviders,
    getModelConfigPath,
    getResolvedDefaultProvider,
    findProjectRootByInitialRequest,
};


