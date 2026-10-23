const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use(express.static(__dirname));

// MẬT KHẨU TRANG QUẢN TRỊ ADMIN
const ADMIN_PASSWORD = "admin123";

// File lưu trữ dữ liệu vĩnh viễn (Chống mất số dư và lịch sử rút tiền)
const DATA_FILE = path.join(__dirname, 'data.json');

let db = {
    users: {},        // { "USER_123": { balance: 0 } }
    withdrawals: []   // Danh sách yêu cầu rút tiền
};

// Tải dữ liệu từ file
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            db = JSON.parse(raw);
        }
    } catch (e) {
        console.error("Lỗi đọc data.json:", e);
    }
}

// Lưu dữ liệu vào file
function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
    } catch (e) {
        console.error("Lỗi ghi data.json:", e);
    }
}

loadData();

// BỘ NHỚ THEO DÕI CHỐNG GIAN LẬN
let webVisitorTimers = {}; // { "IP": timestamp_bat_dau_vao_web_khach }
let activeCodes = {};      // { "PASS123": { expires } }

// Helper lấy chuẩn địa chỉ IP người dùng
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

// ========================================================
// 1. KHI NGƯỜI DÙNG BẮT ĐẦU VÀO WEB KHÁCH (BẮT ĐẦU TÍNH GIỜ)
// ========================================================
app.post('/api/web-khach-start', (req, res) => {
    const ip = getClientIp(req);
    webVisitorTimers[ip] = Date.now();
    res.json({ success: true });
});

// ========================================================
// 2. KHI HẾT GIỜ BẤM LẤY MÃ (CHỐNG TOOL BẮN LẤY MÃ TỨC THÌ)
// ========================================================
app.post('/api/get-code', (req, res) => {
    const ip = getClientIp(req);
    const startTime = webVisitorTimers[ip];

    // CHỐNG HACK: Nếu chưa mở trang web khách bao giờ mà tự gọi API
    if (!startTime) {
        return res.status(400).json({ 
            success: false, 
            message: "Bạn cần mở trang web và chờ đồng hồ đếm ngược!" 
        });
    }

    // Kiểm tra thời gian đã ở lại trên trang (Yêu cầu ít nhất 8 giây)
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const REQUIRED_TIME = 8; // Đặt 8 giây để người dùng không bị lỗi mạng

    if (elapsedSeconds < REQUIRED_TIME) {
        return res.status(400).json({ 
            success: false, 
            message: `Bạn chưa đợi đủ thời gian! Vui lòng chờ đồng hồ chạy hết.` 
        });
    }

    // Hợp lệ -> Sinh mã 6 số
    const randomCode = "PASS" + Math.floor(100000 + Math.random() * 900000);
    
    // Mã có hiệu lực trong 5 phút
    activeCodes[randomCode] = {
        expires: Date.now() + 5 * 60 * 1000
    };

    // Xóa bộ đếm của IP này để tránh xin mã liên tục
    delete webVisitorTimers[ip];

    console.log(`[+] Cấp mã thành công cho IP ${ip}: ${randomCode}`);
    res.json({ success: true, code: randomCode });
});

// ========================================================
// 3. NỘP MÃ NHẬN TIỀN
// ========================================================
app.post('/api/submit-code', (req, res) => {
    const { userId, code } = req.body;

    if (!code || !activeCodes[code]) {
        return res.json({ success: false, message: "Mã không đúng hoặc đã hết hạn!" });
    }

    const codeData = activeCodes[code];

    if (Date.now() > codeData.expires) {
        delete activeCodes[code];
        return res.json({ success: false, message: "Mã đã quá hạn 5 phút!" });
    }

    // Đúng mã -> Hủy mã ngay lập tức (Chống nộp lần 2)
    delete activeCodes[code];

    // Cộng 300đ cho người dùng
    if (!db.users[userId]) db.users[userId] = { balance: 0 };
    db.users[userId].balance += 300;
    saveData(); // Lưu vào file vĩnh viễn

    console.log(`[💰] ${userId} nộp mã đúng (+300đ). Số dư: ${db.users[userId].balance}đ`);
    res.json({ 
        success: true, 
        message: "Chúc mừng! Bạn đã nhận được 300đ", 
        newBalance: db.users[userId].balance 
    });
});

// ========================================================
// 4. LẤY SỐ DƯ NGƯỜI DÙNG
// ========================================================
app.get('/api/user/:id', (req, res) => {
    const userId = req.params.id;
    const balance = db.users[userId] ? db.users[userId].balance : 0;
    res.json({ userId, balance });
});

// ========================================================
// 5. YÊU CẦU RÚT TIỀN (CHỐNG RÚT ÂM)
// ========================================================
app.post('/api/withdraw', (req, res) => {
    const { userId, method, accountNumber, accountName, amount } = req.body;
    const withdrawAmount = parseInt(amount);

    if (!db.users[userId]) db.users[userId] = { balance: 0 };

    if (isNaN(withdrawAmount) || withdrawAmount < 1000) {
        return res.json({ success: false, message: "Số tiền rút tối thiểu là 1.000đ!" });
    }

    if (db.users[userId].balance < withdrawAmount) {
        return res.json({ 
            success: false, 
            message: `Số dư không đủ! Bạn chỉ có ${db.users[userId].balance}đ.` 
        });
    }

    if (!accountNumber || !accountName) {
        return res.json({ success: false, message: "Vui lòng nhập đầy đủ thông tin!" });
    }

    // Trừ số dư
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

    console.log(`[💸] Lệnh rút: ${userId} rút ${withdrawAmount}đ qua ${method}`);
    res.json({ 
        success: true, 
        message: "Yêu cầu rút tiền thành công! Admin sẽ duyệt sớm.", 
        newBalance: db.users[userId].balance 
    });
});

// ========================================================
// 6. ADMIN API (BẢO VỆ BẰNG MẬT KHẨU)
// ========================================================
app.post('/api/admin/withdrawals', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: "Sai mật khẩu Admin!" });
    }
    res.json({ success: true, withdrawals: db.withdrawals, users: db.users });
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
        return res.json({ success: true, message: "Đã cập nhật: ĐÃ CHUYỂN TIỀN" });
    }
    res.json({ success: false, message: "Không tìm thấy yêu cầu này!" });
});

// Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
});
