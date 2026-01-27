const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

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

// ================= 配置区域 =================
const FEISHU_CONFIG = {
    // 使用你提供的凭证
    appId: process.env.FEISHU_APP_ID || 'cli_a9f2f520bf79dcc7',
    appSecret: process.env.FEISHU_APP_SECRET || 'zMBAfGeBFWdGgxkmc53cHbJ442AeEyIg',
    // 你提供的特定表格 ID
    tableIds: {
        users: 'tbl9tatvwt2gZhAi',      // 用户表
        scores: 'tblcrqvqZe46vPcx'      // 曼波模拟器/排行榜表
    }
};

let tenantAccessToken = '';
let tokenExpiry = 0;

// ================= 工具函数 =================

// 辅助函数：延迟执行
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// [已修复] 飞书日期字段必须接受 13位毫秒时间戳 (Number 类型)，而不是字符串
// 飞书会自动将其转换为 YYYY-MM-DD HH:mm:ss 显示
// 原来的 getFormattedDateTime 返回字符串会导致 DatetimeFieldConvFail 错误

// 核心封装：带重试机制的请求
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

// ================= 业务路由 =================

// 1. 用户注册/登录
// 逻辑：前端生成或用户输入 -> 后端查重 -> 写入飞书
app.post('/api/register', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.json({ success: false, msg: "用户名不能为空" });

    try {
        const token = await getTenantAccessToken();
        const tableId = FEISHU_CONFIG.tableIds.users;

        // 1. 查重 (Filter)
        // 注意：飞书 API 筛选字段需要确保该字段在多维表格中是索引或文本类型
        const filter = `CurrentValue.[姓名]="${username}"`;
        const searchUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${await getAppToken()}/tables/${tableId}/records?filter=${encodeURIComponent(filter)}`;
        
        // 为了简化，这里我们假设我们有一个有效的 app_token。
        // 在实际飞书API中，操作表格通常需要 app_token (base_token)。
        // *重要*：由于你提供的 token 'AU53bxFVyaAxRtszH7TcZpmnnVf' 可能是 app_token，我们在此使用。
        const APP_TOKEN = 'AU53bxFVyaAxRtszH7TcZpmnnVf'; 

        const searchRes = await callFeishuAPI('get', `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?filter=${encodeURIComponent(filter)}`, null, {
            Authorization: `Bearer ${token}`
        });

        if (searchRes.data.data.total > 0) {
            // 用户已存在，直接返回成功，视为登录
            return res.json({ success: true, msg: "欢迎回来", isNew: false, username });
        }

        // 2. 新增用户
        const createRes = await callFeishuAPI('post', `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`, {
            fields: {
                "姓名": username,
                // [修复] 使用 Date.now() 毫秒时间戳，飞书会自动转为精确的日期时间
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

// 2. 提交曼波指数 (记录分数)
app.post('/api/score', async (req, res) => {
    const { username, score } = req.body;
    if (!username || score === undefined) return res.json({ success: false, msg: "数据不完整" });

    try {
        const token = await getTenantAccessToken();
        const APP_TOKEN = 'AU53bxFVyaAxRtszH7TcZpmnnVf';
        const tableId = FEISHU_CONFIG.tableIds.scores;

        // 直接写入一条新记录 (根据需求：刷新日期, 曼波指数, 姓名)
        const createRes = await callFeishuAPI('post', `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`, {
            fields: {
                "姓名": username,
                "曼波指数": parseInt(score),
                // [修复] 使用 Date.now() 毫秒时间戳
                "刷新日期": Date.now() 
            }
        }, { Authorization: `Bearer ${token}` });

        res.json({ success: true, msg: "成绩已上传" });

    } catch (e) {
        console.error("分数上传失败:", e.message);
        res.status(500).json({ success: false });
    }
});

// 3. 获取曼波看板 (排行榜)
app.get('/api/leaderboard', async (req, res) => {
    try {
        const token = await getTenantAccessToken();
        const APP_TOKEN = 'AU53bxFVyaAxRtszH7TcZpmnnVf';
        const tableId = FEISHU_CONFIG.tableIds.scores;

        // 排序并限制返回 10 条
        // sort 格式: ["字段名 DESC"]
        const sort = JSON.stringify(["曼波指数 DESC"]);
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?sort=${encodeURIComponent(sort)}`;

        // 注意：飞书API获取列表稍有不同，这里使用简化的列表获取逻辑，实际可能需要处理分页
        // 这里为了演示，我们获取前 20 条然后在内存里截取（如果API不支持直接TopN）
        // 但 sort 参数通常是支持的
        
        const listRes = await callFeishuAPI('get', url, null, {
            Authorization: `Bearer ${token}`
        });

        if (listRes.data.code === 0) {
            const items = listRes.data.data.items || [];
            // 提取需要的数据
            const leaderboard = items.map(item => {
                // 格式化时间戳以便前端显示 (可选)
                let dateStr = '-';
                if (item.fields["刷新日期"]) {
                    const d = new Date(item.fields["刷新日期"]);
                    // 简单的格式化：YYYY-MM-DD
                    dateStr = d.toISOString().split('T')[0]; 
                }
                return {
                    name: item.fields["姓名"],
                    score: item.fields["曼波指数"],
                    date: dateStr
                };
            }).slice(0, 10); // 确保只取前10

            res.json({ success: true, data: leaderboard });
        } else {
            throw new Error(listRes.data.msg);
        }

    } catch (e) {
        console.error("获取排行榜失败:", e.message);
        res.status(500).json({ success: false, data: [] });
    }
});

// 辅助：获取 APP_TOKEN (如果需要动态获取，但在本例中你已经提供了)
async function getAppToken() {
    return 'AU53bxFVyaAxRtszH7TcZpmnnVf';
}

// 启动服务
if (require.main === module) {
    app.use(express.static(__dirname)); // 托管静态文件 (html)
    app.listen(PORT, () => {
        console.log(`\n✅ 曼波网站服务运行中: http://localhost:${PORT}`);
    });
}

module.exports = app;