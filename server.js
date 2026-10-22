const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use(express.static(__dirname));

// MẬT KHẨU TRANG QUẢN TRỊ ADMIN (Bạn có thể đổi mật khẩu này theo ý thích)
const ADMIN_PASSWORD = "admin123";

// File lưu trữ dữ liệu vĩnh viễn (Chống mất số dư và lịch sử rút tiền khi máy chủ khởi động lại)
const DATA_FILE = path.join(__dirname, 'data.json');

let db = {
    users: {},        // { "USER_123": { balance: 0 } }
    withdrawals: []   // Danh sách yêu cầu rút tiền
};

// Tải dữ liệu từ file lên RAM
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

// BỘ NHỚ THEO DÕI CHỐNG GIAN LẬN / CHỐNG TOOL
let taskSessions = {}; // { "IP_USER": { startTime: timestamp, campaignId: "..." } }
let activeCodes = {};  // { "PASS123": { userId, expires } }

// Helper lấy IP người dùng
function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

// ==========================================
// 1. API: BẮT ĐẦU NHIỆM VỤ (Bắt đầu tính giờ 60s)
// ==========================================
app.post('/api/start-task', (req, res) => {
    const { userId, campaignId } = req.body;
    const ip = getClientIp(req);
    const sessionKey = `${ip}_${userId}`;

    taskSessions[sessionKey] = {
        userId,
        campaignId: campaignId || 'DEFAULT',
        startTime: Date.now()
    };

    res.json({ success: true, message: "Đã bắt đầu tính giờ làm nhiệm vụ!" });
});

// ==========================================
// 2. API: CẤP MÃ (CHỐNG TOOL HACK THỜI GIAN)
// ==========================================
app.post('/api/get-code', (req, res) => {
    const { userId, campaignId } = req.body;
    const ip = getClientIp(req);
    const sessionKey = `${ip}_${userId}`;
    const session = taskSessions[sessionKey];

    // CHỐNG HACK 1: Phải bấm "Bắt đầu nhiệm vụ" trước
    if (!session) {
        return res.status(400).json({ 
            success: false, 
            message: "Gian lận: Bạn chưa bắt đầu nhiệm vụ hợp lệ từ trang chủ!" 
        });
    }

    // CHỐNG HACK 2: Kiểm tra xem đã ở lại trên trang đủ thời gian chưa (Ví dụ tối thiểu 50 giây)
    const elapsedSeconds = Math.floor((Date.now() - session.startTime) / 1000);
    const REQUIRED_TIME = 10; // Đặt 10 giây để bạn test (Sau này có khách thật đổi thành 60 giây)

    if (elapsedSeconds < REQUIRED_TIME) {
        return res.status(400).json({ 
            success: false, 
            message: `Gian lận: Bạn mới ở lại ${elapsedSeconds}s, chưa đủ ${REQUIRED_TIME}s!` 
        });
    }

    // Hợp lệ -> Sinh mã ngẫu nhiên 6 số
    const randomCode = "PASS" + Math.floor(100000 + Math.random() * 900000);
    
    // Mã chỉ dùng được trong 5 phút
    activeCodes[randomCode] = {
        userId,
        expires: Date.now() + 5 * 60 * 1000
    };

    // Hủy phiên làm việc vừa rồi để chống xin mã nhiều lần
    delete taskSessions[sessionKey];

    console.log(`[+] Cấp mã hợp lệ cho ${userId} (${ip}): ${randomCode}`);
    res.json({ success: true, code: randomCode });
});

// ==========================================
// 3. API: NỘP MÃ NHẬN TIỀN
// ==========================================
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

    // CHỐNG HACK 3: Người nào xin mã thì người đó mới nộp được mã đó
    if (codeData.userId && codeData.userId !== userId) {
        return res.json({ success: false, message: "Mã này không phải do bạn tạo ra!" });
    }

    // Đúng mã -> Hủy mã ngay lập tức (Chống nộp lại lần 2)
    delete activeCodes[code];

    // Cộng 300đ cho người dùng
    if (!db.users[userId]) db.users[userId] = { balance: 0 };
    db.users[userId].balance += 300;
    saveData(); // Lưu vĩnh viễn

    console.log(`[💰] ${userId} nộp mã đúng (+300đ). Số dư mới: ${db.users[userId].balance}đ`);
    res.json({ 
        success: true, 
        message: "Chúc mừng! Bạn đã nhận được 300đ", 
        newBalance: db.users[userId].balance 
    });
});

// ==========================================
// 4. API: LẤY SỐ DƯ HIỆN TẠI CỦA USER
// ==========================================
app.get('/api/user/:id', (req, res) => {
    const userId = req.params.id;
    const balance = db.users[userId] ? db.users[userId].balance : 0;
    res.json({ userId, balance });
});

// ==========================================
// 5. API: YÊU CẦU RÚT TIỀN (CHỐNG RÚT ÂM TIỀN)
// ==========================================
app.post('/api/withdraw', (req, res) => {
    const { userId, method, accountNumber, accountName, amount } = req.body;
    const withdrawAmount = parseInt(amount);

    if (!db.users[userId]) db.users[userId] = { balance: 0 };

    if (isNaN(withdrawAmount) || withdrawAmount < 1000) {
        return res.json({ success: false, message: "Số tiền rút tối thiểu là 1.000đ!" });
    }

    // CHỐNG HACK 4: Kiểm tra nghiêm ngặt số dư thật trên máy chủ
    if (db.users[userId].balance < withdrawAmount) {
        return res.json({ 
            success: false, 
            message: `Số dư không đủ! Bạn chỉ có ${db.users[userId].balance}đ.` 
        });
    }

    if (!accountNumber || !accountName) {
        return res.json({ success: false, message: "Vui lòng nhập đầy đủ thông tin tài khoản!" });
    }

    // Trừ số dư an toàn
    db.users[userId].balance -= withdrawAmount;

    // Ghi nhận lệnh rút tiền
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
    saveData(); // Lưu vĩnh viễn vào file

    console.log(`[💸] Lệnh rút: ${userId} rút ${withdrawAmount}đ (${method}: ${accountNumber})`);
    res.json({ 
        success: true, 
        message: "Yêu cầu rút tiền thành công! Admin sẽ duyệt và bắn tiền sớm.", 
        newBalance: db.users[userId].balance 
    });
});

// ==========================================
// 6. API ADMIN: BẢO VỆ BẰNG MẬT KHẨU
// ==========================================
app.post('/api/admin/withdrawals', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: "Sai mật khẩu Admin!" });
    }
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
        return res.json({ success: true, message: "Đã cập nhật: ĐÃ CHUYỂN TIỀN" });
    }
    res.json({ success: false, message: "Không tìm thấy yêu cầu này!" });
});

// Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server an toàn đang chạy tại: http://localhost:${PORT}`);
});
