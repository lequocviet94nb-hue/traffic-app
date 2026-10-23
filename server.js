const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use(express.static(__dirname));

// ========================================================
// CẤU HÌNH HỆ THỐNG CHUẨN MONEYTASK
// ========================================================
const ADMIN_PASSWORD = "admin123";
const MIN_WITHDRAW_AMOUNT = 5000; // RÚT TIỀN TỐI THIỂU LÀ 5.000 VNĐ
const MAX_SHORTLINK_PER_IP = 2;   // Giới hạn 2 lượt/IP/ngày để đảm bảo 100% có lãi từ YeuMoney
const DAILY_CHECKIN_REWARD = 100; // Thưởng điểm danh mỗi ngày 100đ

const DATA_FILE = path.join(__dirname, 'data.json');

let db = {
    users: {},        // { "U12345": { balance: 0, refBy: null } }
    withdrawals: [],  // [ { id, userId, method, accountNumber, accountName, amount, status, time } ]
    vipTasks: [],     // [ { id, userId, taskName, proof, reward, status, time } ]
    ipDailyShortlink: {}, // { "2026-10-23": { "IP": count } }
    dailyCheckins: {}     // { "2026-10-23": { "IP_USER": true } }
};

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            db = JSON.parse(raw);
            if (!db.ipDailyShortlink) db.ipDailyShortlink = {};
            if (!db.dailyCheckins) db.dailyCheckins = {};
            if (!db.vipTasks) db.vipTasks = [];
        }
    } catch (e) {
        console.error("Lỗi đọc data.json:", e);
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
    } catch (e) {
        console.error("Lỗi ghi data.json:", e);
    }
}

loadData();

// BỘ NHỚ THEO DÕI AN NINH
let webVisitorTimers = {};
let activeCodes = {};
let adminFailedAttempts = {};

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

function getTodayString() {
    return new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function cleanString(str) {
    return String(str || '').replace(/[<>&'"]/g, '').trim();
}

// Tự dọn mã quá hạn mỗi 10 phút
setInterval(() => {
    const now = Date.now();
    for (let c in activeCodes) {
        if (now > activeCodes[c].expires) delete activeCodes[c];
    }
}, 10 * 60 * 1000);

// ========================================================
// 1. ĐIỂM DANH HÀNG NGÀY (GIỮ CHÂN NGƯỜI DÙNG GIỐNG MONEYTASK)
// ========================================================
app.post('/api/daily-checkin', (req, res) => {
    let { userId } = req.body;
    userId = cleanString(userId);
    const ip = getClientIp(req);
    const today = getTodayString();
    const key = `${today}_${ip}_${userId}`;

    if (!db.dailyCheckins[today]) db.dailyCheckins[today] = {};

    if (db.dailyCheckins[today][key]) {
        return res.json({ success: false, message: "Hôm nay bạn đã điểm danh rồi! Hãy quay lại vào ngày mai nhé." });
    }

    db.dailyCheckins[today][key] = true;
    if (!db.users[userId]) db.users[userId] = { balance: 0 };
    db.users[userId].balance += DAILY_CHECKIN_REWARD;
    saveData();

    res.json({ 
        success: true, 
        message: `Điểm danh thành công! Nhận ngay +${DAILY_CHECKIN_REWARD}đ vào tài khoản.`, 
        newBalance: db.users[userId].balance 
    });
});

// ========================================================
// 2. NHIỆM VỤ VƯỢT LINK (CHỐNG GIAN LẬN & CHỐNG LỖ TIỀN)
// ========================================================
app.post('/api/web-khach-start', (req, res) => {
    const ip = getClientIp(req);
    const today = getTodayString();

    if (!db.ipDailyShortlink[today]) db.ipDailyShortlink[today] = {};
    const count = db.ipDailyShortlink[today][ip] || 0;

    if (count >= MAX_SHORTLINK_PER_IP) {
        return res.status(403).json({ 
            success: false, 
            message: `Mỗi ngày chỉ được vượt link ${MAX_SHORTLINK_PER_IP} lần trên 1 mạng WiFi! Vui lòng quay lại vào ngày mai hoặc chuyển sang mạng 4G.` 
        });
    }

    webVisitorTimers[ip] = Date.now();
    res.json({ success: true });
});

app.post('/api/get-code', (req, res) => {
    const ip = getClientIp(req);
    const startTime = webVisitorTimers[ip];

    if (!startTime) {
        return res.status(400).json({ success: false, message: "Gian lận: Bạn chưa mở trang web này hợp lệ!" });
    }

    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    if (elapsedSeconds < 8) {
        return res.status(400).json({ success: false, message: "Bạn chưa đợi đủ thời gian quy định!" });
    }

    const randomCode = "PASS" + Math.floor(100000 + Math.random() * 900000);
    activeCodes[randomCode] = {
        ip: ip,
        expires: Date.now() + 5 * 60 * 1000
    };

    delete webVisitorTimers[ip];
    res.json({ success: true, code: randomCode });
});

app.post('/api/submit-code', (req, res) => {
    let { userId, code } = req.body;
    userId = cleanString(userId).slice(0, 20);
    code = cleanString(code);
    const ip = getClientIp(req);
    const today = getTodayString();

    if (!code || !activeCodes[code]) {
        return res.json({ success: false, message: "Mã không đúng hoặc đã hết hạn!" });
    }

    const codeData = activeCodes[code];
    if (Date.now() > codeData.expires) {
        delete activeCodes[code];
        return res.json({ success: false, message: "Mã đã quá hạn 5 phút!" });
    }

    if (codeData.ip && codeData.ip !== ip) {
        return res.json({ success: false, message: "Mã này không phải do máy bạn tạo ra!" });
    }

    delete activeCodes[code];

    if (!db.ipDailyShortlink[today]) db.ipDailyShortlink[today] = {};
    db.ipDailyShortlink[today][ip] = (db.ipDailyShortlink[today][ip] || 0) + 1;

    if (!db.users[userId]) db.users[userId] = { balance: 0 };
    db.users[userId].balance += 300;
    saveData();

    res.json({ 
        success: true, 
        message: "Chúc mừng! Bạn nhận được 300đ", 
        newBalance: db.users[userId].balance 
    });
});

// ========================================================
// 3. NHIỆM VỤ PRO VIP (TẠO GMAIL / CÀI APP / ĐÁNH GIÁ MAPS)
// ========================================================
app.post('/api/submit-vip-task', (req, res) => {
    let { userId, taskType, proof } = req.body;
    userId = cleanString(userId);
    taskType = cleanString(taskType);
    proof = cleanString(proof);

    if (!proof) {
        return res.json({ success: false, message: "Vui lòng nhập bằng chứng hoàn thành nhiệm vụ!" });
    }

    let reward = 1000;
    let taskName = "Nhiệm Vụ VIP";
    if (taskType === 'GMAIL') {
        reward = 1500;
        taskName = "Tạo Tài Khoản Gmail";
    } else if (taskType === 'MAPS') {
        reward = 2000;
        taskName = "Đánh Giá 5 Sao Google Maps";
    } else if (taskType === 'APP_BANK') {
        reward = 30000;
        taskName = "Mở Tài Khoản MB Bank";
    }

    const newVip = {
        id: Date.now().toString(),
        userId,
        taskName,
        proof,
        reward,
        status: 'PENDING',
        time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    };

    db.vipTasks.unshift(newVip);
    saveData();

    res.json({ 
        success: true, 
        message: `Đã gửi bằng chứng nhiệm vụ ${taskName}! Admin sẽ kiểm tra và cộng ${reward.toLocaleString()}đ cho bạn trong 24h.` 
    });
});

// ========================================================
// 4. LẤY THÔNG TIN TÀI KHOẢN & SỐ DƯ
// ========================================================
app.get('/api/user/:id', (req, res) => {
    const userId = cleanString(req.params.id);
    const balance = db.users[userId] ? db.users[userId].balance : 0;
    const ip = getClientIp(req);
    const today = getTodayString();
    const shortlinkToday = (db.ipDailyShortlink[today] && db.ipDailyShortlink[today][ip]) || 0;
    const checkinKey = `${today}_${ip}_${userId}`;
    const hasCheckedIn = !!(db.dailyCheckins[today] && db.dailyCheckins[today][checkinKey]);

    res.json({ 
        userId, 
        balance, 
        shortlinkToday, 
        maxShortlink: MAX_SHORTLINK_PER_IP,
        hasCheckedIn,
        minWithdraw: MIN_WITHDRAW_AMOUNT
    });
});

// ========================================================
// 5. YÊU CẦU RÚT TIỀN (MIN RÚT 5.000 VNĐ CHỐNG LỖ)
// ========================================================
app.post('/api/withdraw', (req, res) => {
    let { userId, method, accountNumber, accountName, amount } = req.body;
    userId = cleanString(userId);
    method = cleanString(method);
    accountNumber = cleanString(accountNumber);
    accountName = cleanString(accountName).toUpperCase();
    const withdrawAmount = parseInt(amount);

    if (!db.users[userId]) db.users[userId] = { balance: 0 };

    // KHÓA RÚT TỐI THIỂU 5.000 VNĐ (QUAN TRỌNG ĐỂ KHÔNG BỊ LỖ VỐN)
    if (isNaN(withdrawAmount) || withdrawAmount < MIN_WITHDRAW_AMOUNT) {
        return res.json({ 
            success: false, 
            message: `Số tiền rút tối thiểu là ${MIN_WITHDRAW_AMOUNT.toLocaleString()}đ!` 
        });
    }

    if (db.users[userId].balance < withdrawAmount) {
        return res.json({ 
            success: false, 
            message: `Số dư không đủ! Bạn hiện có ${db.users[userId].balance.toLocaleString()}đ (Cần tối thiểu ${MIN_WITHDRAW_AMOUNT.toLocaleString()}đ để rút).` 
        });
    }

    if (!accountNumber || !accountName) {
        return res.json({ success: false, message: "Vui lòng nhập đầy đủ thông tin tài khoản nhận tiền!" });
    }

    const hasPending = db.withdrawals.some(w => w.userId === userId && w.status === 'PENDING');
    if (hasPending) {
        return res.json({ 
            success: false, 
            message: "Bạn đang có 1 lệnh rút tiền chờ duyệt! Vui lòng đợi Admin chuyển khoản trước khi rút tiếp." 
        });
    }

    // Trừ số dư
    db.users[userId].balance -= withdrawAmount;

    const newRequest = {
        id: Date.now().toString(),
        userId,
        method,
        accountNumber,
        accountName,
        amount: withdrawAmount,
        status: 'PENDING',
        time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    };

    db.withdrawals.unshift(newRequest);
    saveData();

    res.json({ 
        success: true, 
        message: "Gửi yêu cầu rút tiền thành công! Admin sẽ duyệt và bắn tiền sớm.", 
        newBalance: db.users[userId].balance 
    });
});

// ========================================================
// 6. TRANG ADMIN BẢO MẬT
// ========================================================
app.post('/api/admin/data', (req, res) => {
    const { password } = req.body;
    const ip = getClientIp(req);

    if (adminFailedAttempts[ip] && adminFailedAttempts[ip].lockUntil > Date.now()) {
        const remaining = Math.ceil((adminFailedAttempts[ip].lockUntil - Date.now()) / 60000);
        return res.status(403).json({ success: false, message: `IP bị khóa do gõ sai pass quá 5 lần. Thử lại sau ${remaining} phút.` });
    }

    if (password !== ADMIN_PASSWORD) {
        if (!adminFailedAttempts[ip]) adminFailedAttempts[ip] = { count: 0, lockUntil: 0 };
        adminFailedAttempts[ip].count++;
        if (adminFailedAttempts[ip].count >= 5) adminFailedAttempts[ip].lockUntil = Date.now() + 15 * 60 * 1000;
        return res.status(403).json({ success: false, message: "Sai mật khẩu Admin!" });
    }

    delete adminFailedAttempts[ip];
    res.json({ 
        success: true, 
        withdrawals: db.withdrawals, 
        vipTasks: db.vipTasks,
        users: db.users 
    });
});

app.post('/api/admin/approve-withdraw', (req, res) => {
    const { password, id } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false, message: "Sai pass!" });

    const item = db.withdrawals.find(w => w.id === id);
    if (item) {
        item.status = 'COMPLETED';
        saveData();
        return res.json({ success: true, message: "Đã duyệt: ĐÃ CHUYỂN TIỀN THÀNH CÔNG" });
    }
    res.json({ success: false, message: "Không tìm thấy yêu cầu!" });
});

app.post('/api/admin/approve-vip', (req, res) => {
    const { password, id } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false, message: "Sai pass!" });

    const item = db.vipTasks.find(t => t.id === id);
    if (item && item.status === 'PENDING') {
        item.status = 'COMPLETED';
        if (!db.users[item.userId]) db.users[item.userId] = { balance: 0 };
        db.users[item.userId].balance += item.reward;
        saveData();
        return res.json({ success: true, message: `Đã duyệt nhiệm vụ và cộng ${item.reward}đ cho ${item.userId}!` });
    }
    res.json({ success: false, message: "Không tìm thấy hoặc đã duyệt rồi!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 MoneyTask Pro đang chạy tại: http://localhost:${PORT}`);
});
