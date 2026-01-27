const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// 请求日志
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ================= 关键配置：静态文件 MIME 类型 =================

const staticOptions = {
    setHeaders: (res, filePath) => {
        if (filePath.toLowerCase().endsWith('.mp3')) {
            // 强制设置音频 MIME 类型，防止被当成二进制流下载
            res.set('Content-Type', 'audio/mpeg');
            // 支持范围请求 (Range Requests)，这对于音频拖动进度条和 Safari 播放至关重要
            res.set('Accept-Ranges', 'bytes');
        }
    }
};

// 1. 静态资源托管
// 强制让 Express 托管 music 目录，并应用上面的 MIME 配置
app.use('/music', express.static(path.join(__dirname, 'music'), staticOptions));
app.use(express.static(__dirname, staticOptions));

// 2. 文件侦探 API
app.get('/api/debug-files', (req, res) => {
    const debugInfo = {
        currentDir: __dirname,
        musicDirExists: false,
        musicFiles: [],
        rootFiles: []
    };

    try {
        debugInfo.rootFiles = fs.readdirSync(__dirname).map(file => {
            const stat = fs.statSync(path.join(__dirname, file));
            return { name: file, size: stat.size };
        });

        const musicPath = path.join(__dirname, 'music');
        if (fs.existsSync(musicPath)) {
            debugInfo.musicDirExists = true;
            debugInfo.musicFiles = fs.readdirSync(musicPath).map(file => {
                const stat = fs.statSync(path.join(musicPath, file));
                return { name: file, size: stat.size }; // 返回文件大小，检查是否为 0
            });
        }
        
        res.json({
            success: true,
            msg: "文件系统侦探报告",
            data: debugInfo,
            tips: "请检查 musicFiles 中是否有你的 MP3，且 size > 0。"
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ================= 配置区域 =================
const FEISHU_CONFIG = {
    appId: process.env.FEISHU_APP_ID || 'cli_a9f2f520bf79dcc7',
    appSecret: process.env.FEISHU_APP_SECRET || 'zMBAfGeBFWdGgxkmc53cHbJ442AeEyIg',
    tableIds: {
        users: 'tbl9tatvwt2gZhAi',
        scores: 'tblcrqvqZe46vPcx'
    }
};

let tenantAccessToken = '';
let tokenExpiry = 0;

// ================= 工具函数 =================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callFeishuAPI(method, url, data = null, headers = {}) {
    let retries = 0;
    const maxRetries = 3;
    
    while (retries <= maxRetries) {
        try {
            const config = { method, url, headers };
            if (data) config.data = data;
            
            const response = await axios(config);
            return response;
        } catch (error) {
            const status = error.response ? error.response.status : 0;
            if (retries < maxRetries && (status === 429 || status >= 500)) {
                retries++;
                const delay = 500 * Math.pow(2, retries - 1);
                console.warn(`⚠️ 飞书 API 请求受限 (${status})，${delay}ms 后重试...`);
                await sleep(delay);
                continue;
            }
            throw error;
        }
    }
}

async function getTenantAccessToken() {
    const now = Date.now() / 1000;
    if (tenantAccessToken && now < tokenExpiry) return tenantAccessToken;
    try {
        const res = await callFeishuAPI('post', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            "app_id": FEISHU_CONFIG.appId,
            "app_secret": FEISHU_CONFIG.appSecret
        });

        if (res.data.code === 0) {
            tenantAccessToken = res.data.tenant_access_token;
            tokenExpiry = now + res.data.expire - 60;
            return tenantAccessToken;
        }
        throw new Error(res.data.msg);
    } catch (e) {
        console.error('❌ Token 获取失败:', e.message);
        throw e;
    }
}

async function getAppToken() {
    return 'AU53bxFVyaAxRtszH7TcZpmnnVf';
}

// ================= 业务路由 =================

app.post('/api/register', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.json({ success: false, msg: "用户名不能为空" });

    try {
        const token = await getTenantAccessToken();
        const tableId = FEISHU_CONFIG.tableIds.users;
        const APP_TOKEN = await getAppToken();

        const filter = `CurrentValue.[姓名]="${username}"`;
        const searchRes = await callFeishuAPI('get', `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?filter=${encodeURIComponent(filter)}`, null, {
            Authorization: `Bearer ${token}`
        });

        if (searchRes.data.data.total > 0) {
            return res.json({ success: true, msg: "欢迎回来", isNew: false, username });
        }

        const createRes = await callFeishuAPI('post', `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`, {
            fields: {
                "姓名": username,
                "建立日期": Date.now() 
            }
        }, { Authorization: `Bearer ${token}` });

        if (createRes.data.code === 0) {
            res.json({ success: true, msg: "注册成功", isNew: true, username });
        } else {
            throw new Error(createRes.data.msg);
        }

    } catch (e) {
        console.error("注册失败:", e.response ? e.response.data : e.message);
        res.status(500).json({ success: false, msg: "服务繁忙" });
    }
});

app.post('/api/score', async (req, res) => {
    const { username, score } = req.body;
    if (!username || score === undefined) return res.json({ success: false, msg: "数据不完整" });

    try {
        const token = await getTenantAccessToken();
        const APP_TOKEN = await getAppToken();
        const tableId = FEISHU_CONFIG.tableIds.scores;

        await callFeishuAPI('post', `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`, {
            fields: {
                "姓名": username,
                "曼波指数": parseInt(score),
                "刷新日期": Date.now() 
            }
        }, { Authorization: `Bearer ${token}` });

        res.json({ success: true, msg: "成绩已上传" });

    } catch (e) {
        console.error("分数上传失败:", e.message);
        res.status(500).json({ success: false });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const token = await getTenantAccessToken();
        const APP_TOKEN = await getAppToken();
        const tableId = FEISHU_CONFIG.tableIds.scores;

        const sort = JSON.stringify(["曼波指数 DESC"]);
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?sort=${encodeURIComponent(sort)}`;
        
        const listRes = await callFeishuAPI('get', url, null, {
            Authorization: `Bearer ${token}`
        });

        if (listRes.data.code === 0) {
            const items = listRes.data.data.items || [];
            const leaderboard = items.map(item => {
                let dateStr = '-';
                if (item.fields["刷新日期"]) {
                    const d = new Date(item.fields["刷新日期"]);
                    dateStr = d.toISOString().split('T')[0]; 
                }
                return {
                    name: item.fields["姓名"],
                    score: item.fields["曼波指数"],
                    date: dateStr
                };
            }).slice(0, 10);

            res.json({ success: true, data: leaderboard });
        } else {
            throw new Error(listRes.data.msg);
        }

    } catch (e) {
        console.error("获取排行榜失败:", e.message);
        res.status(500).json({ success: false, data: [] });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/manbo.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'manbo.html'));
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n✅ 曼波网站服务运行中: http://localhost:${PORT}`);
    });
}

module.exports = app;
