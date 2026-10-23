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
// CẤU HÌNH BẢO MẬT HỆ THỐNG
// ========================================================
const ADMIN_PASSWORD = "admin123"; // Đổi mật khẩu này nếu muốn
const MAX_TASKS_PER_IP_PER_DAY = 2; // YeuMoney chỉ trả tiền 1-2 lần/IP/ngày -> Khóa đúng 2 lần để không bị lỗ vốn!
const COOLDOWN_SECONDS = 60; // Khoảng cách giữa 2 lần làm nhiệm vụ

const DATA_FILE = path.join(__dirname, 'data.json');

let db = {
    users: {},        // { "U12345": { balance: 0 } }
    withdrawals: [],  // [ { id, userId, method, accountNumber, accountName, amount, status, time } ]
    ipDailyTasks: {}  // { "2026-10-23": { "IP_ADDRESS": count } } -> Theo dõi số lượt mỗi IP mỗi ngày
};

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            db = JSON.parse(raw);
            if (!db.ipDailyTasks) db.ipDailyTasks = {};
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

// BỘ NHỚ TẠM THỜI GIAN THỰC
let webVisitorTimers = {}; // { "IP": timestamp }
let activeCodes = {};      // { "PASS123": { expires, ip } }
let adminFailedAttempts = {}; // { "IP": { count, lockUntil } } -> Chống mò pass Admin

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

function getTodayString() {
    return new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function cleanString(str) {
    return String(str || '').replace(/[<>&'"]/g, '').trim();
}

// Tự động dọn dẹp mã hết hạn mỗi 10 phút để tránh nặng RAM
setInterval(() => {
    const now = Date.now();
    for (let c in activeCodes) {
        if (now > activeCodes[c].expires) delete activeCodes[c];
    }
}, 10 * 60 * 1000);

// ========================================================
// 1. API: BẮT ĐẦU VÀO WEB KHÁCH
// ========================================================
app.post('/api/web-khach-start', (req, res) => {
    const ip = getClientIp(req);
    const today = getTodayString();

    if (!db.ipDailyTasks[today]) db.ipDailyTasks[today] = {};
    const ipCount = db.ipDailyTasks[today][ip] || 0;

    // BẢO VỆ TÚI TIỀN: Chặn nếu 1 IP đã làm quá giới hạn trong ngày
    if (ipCount >= MAX_TASKS_PER_IP_PER_DAY) {
        return res.status(403).json({ 
            success: false, 
            message: `Mỗi ngày chỉ được làm ${MAX_TASKS_PER_IP_PER_DAY} nhiệm vụ trên cùng 1 mạng WiFi/IP! Vui lòng quay lại vào ngày mai hoặc đổi sang mạng 4G.` 
        });
    }

    webVisitorTimers[ip] = Date.now();
    res.json({ success: true });
});

// ========================================================
// 2. API: CẤP MÃ (CHỐNG TOOL HACK THỜI GIAN)
// ========================================================
app.post('/api/get-code', (req, res) => {
    const ip = getClientIp(req);
    const today = getTodayString();
    const startTime = webVisitorTimers[ip];

    if (!startTime) {
        return res.status(400).json({ 
            success: false, 
            message: "Gian lận: Bạn chưa mở trang web hoặc đã tải lại trang!" 
        });
    }

    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const REQUIRED_TIME = 8; // Yêu cầu ở lại tối thiểu 8 giây

    if (elapsedSeconds < REQUIRED_TIME) {
        return res.status(400).json({ 
            success: false, 
            message: `Gian lận: Bạn chưa chờ đủ thời gian quy định!` 
        });
    }

    // Sinh mã ngẫu nhiên dạng PASS + 6 số
    const randomCode = "PASS" + Math.floor(100000 + Math.random() * 900000);
    
    // Mã chỉ dùng được trong 5 phút và gắn chặt với IP này
    activeCodes[randomCode] = {
        ip: ip,
        expires: Date.now() + 5 * 60 * 1000
    };

    delete webVisitorTimers[ip];

    console.log(`[+] Cấp mã hợp lệ cho IP ${ip}: ${randomCode}`);
    res.json({ success: true, code: randomCode });
});

// ========================================================
// 3. API: NỘP MÃ NHẬN TIỀN
// ========================================================
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

    // CHỐNG CHIA SẺ MÃ: Mã cấp cho IP nào thì IP đó mới nộp được
    if (codeData.ip && codeData.ip !== ip) {
        return res.json({ success: false, message: "Mã này không phải do máy bạn tạo ra!" });
    }

    // HỦY MÃ NGAY LẬP TỨC (Chống nộp lặp lại)
    delete activeCodes[code];

    // Ghi nhận lượt làm cho IP này trong ngày
    if (!db.ipDailyTasks[today]) db.ipDailyTasks[today] = {};
    db.ipDailyTasks[today][ip] = (db.ipDailyTasks[today][ip] || 0) + 1;

    // Cộng 300đ cho người dùng
    if (!db.users[userId]) db.users[userId] = { balance: 0 };
    db.users[userId].balance += 300;
    saveData();

    console.log(`[💰] ${userId} (${ip}) hoàn thành nhiệm vụ (+300đ). Lượt hôm nay: ${db.ipDailyTasks[today][ip]}`);
    res.json({ 
        success: true, 
        message: "Chúc mừng! Bạn đã nhận được 300đ", 
        newBalance: db.users[userId].balance 
    });
});

// ========================================================
// 4. API: LẤY SỐ DƯ
// ========================================================
app.get('/api/user/:id', (req, res) => {
    const userId = cleanString(req.params.id);
    const balance = db.users[userId] ? db.users[userId].balance : 0;
    const ip = getClientIp(req);
    const today = getTodayString();
    const tasksDoneToday = (db.ipDailyTasks[today] && db.ipDailyTasks[today][ip]) || 0;

    res.json({ 
        userId, 
        balance, 
        tasksDoneToday, 
        maxTasksPerDay: MAX_TASKS_PER_IP_PER_DAY 
    });
});

// ========================================================
// 5. API: RÚT TIỀN (CHỐNG RÚT ÂM & CHỐNG SPAM LỆNH)
// ========================================================
app.post('/api/withdraw', (req, res) => {
    let { userId, method, accountNumber, accountName, amount } = req.body;
    userId = cleanString(userId);
    method = cleanString(method);
    accountNumber = cleanString(accountNumber);
    accountName = cleanString(accountName).toUpperCase();
    const withdrawAmount = parseInt(amount);

    if (!db.users[userId]) db.users[userId] = { balance: 0 };

    // Kiểm tra số tiền hợp lệ
    if (isNaN(withdrawAmount) || withdrawAmount < 1000 || withdrawAmount > 10000000) {
        return res.json({ success: false, message: "Số tiền rút không hợp lệ (Tối thiểu 1.000đ)!" });
    }

    // CHỐNG HACK: Kiểm tra nghiêm ngặt số dư trên máy chủ
    if (db.users[userId].balance < withdrawAmount) {
        return res.json({ 
            success: false, 
            message: `Số dư không đủ! Bạn chỉ có ${db.users[userId].balance.toLocaleString()}đ.` 
        });
    }

    if (!accountNumber || !accountName) {
        return res.json({ success: false, message: "Vui lòng nhập đầy đủ thông tin tài khoản nhận tiền!" });
    }

    // CHỐNG SPAM: Kiểm tra xem người này có lệnh rút nào ĐANG CHỜ DUYỆT không
    const hasPending = db.withdrawals.some(w => w.userId === userId && w.status === 'PENDING');
    if (hasPending) {
        return res.json({ 
            success: false, 
            message: "Bạn đang có 1 yêu cầu rút tiền đang chờ duyệt! Vui lòng đợi Admin chuyển khoản trước khi đặt lệnh tiếp theo." 
        });
    }

    // Trừ số dư an toàn
    db.users[userId].balance -= withdrawAmount;

    // Ghi nhận lệnh rút
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

    console.log(`[💸] Lệnh rút: ${userId} rút ${withdrawAmount.toLocaleString()}đ (${method}: ${accountNumber})`);
    res.json({ 
        success: true, 
        message: "Gửi yêu cầu rút tiền thành công! Admin sẽ duyệt và bắn tiền sớm.", 
        newBalance: db.users[userId].balance 
    });
});

// ========================================================
// 6. ADMIN API (CHỐNG MÒ PASS / BRUTE-FORCE)
// ========================================================
app.post('/api/admin/withdrawals', (req, res) => {
    const { password } = req.body;
    const ip = getClientIp(req);

    // Kiểm tra khóa IP nếu gõ sai pass quá 5 lần
    if (adminFailedAttempts[ip] && adminFailedAttempts[ip].lockUntil > Date.now()) {
        const remainingMinutes = Math.ceil((adminFailedAttempts[ip].lockUntil - Date.now()) / 60000);
        return res.status(403).json({ 
            success: false, 
            message: `IP của bạn bị tạm khóa vì nhập sai mật khẩu quá 5 lần! Thử lại sau ${remainingMinutes} phút.` 
        });
    }

    if (password !== ADMIN_PASSWORD) {
        if (!adminFailedAttempts[ip]) adminFailedAttempts[ip] = { count: 0, lockUntil: 0 };
        adminFailedAttempts[ip].count += 1;
        if (adminFailedAttempts[ip].count >= 5) {
            adminFailedAttempts[ip].lockUntil = Date.now() + 15 * 60 * 1000; // Khóa 15 phút
        }
        return res.status(403).json({ success: false, message: "Sai mật khẩu Admin!" });
    }

    // Đăng nhập đúng -> Xóa lịch sử sai
    delete adminFailedAttempts[ip];

    res.json({ 
        success: true, 
        withdrawals: db.withdrawals, 
        users: db.users 
    });
});

app.post('/api/admin/approve', (req, res) => {
    const { password, id } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: "Sai mật khẩu Admin!" });
    }

    const item = db.withdrawals.find(w => w.id === id);
    if (item) {
        item.status = 'COMPLETED';
        saveData();
        return res.json({ success: true, message: "Đã cập nhật trạng thái: ĐÃ CHUYỂN TIỀN" });
    }
    res.json({ success: false, message: "Không tìm thấy yêu cầu này!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🛡️ Server bảo mật tối đa đang chạy tại: http://localhost:${PORT}`);
});
