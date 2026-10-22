const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use(express.static(__dirname));

// 1. Bộ nhớ tạm lưu tài khoản và mã nhiệm vụ
let users = {
    "user1": { balance: 0 } // Tài khoản mẫu mặc định
};
let activeCodes = {}; // Lưu mã: { "PASS123": { campaignId, expires } }

// 2. API cấp mã (Khi người dùng chờ đủ 60s trên web khách)
app.post('/api/get-code', (req, res) => {
    const { campaignId } = req.body;
    
    // Sinh mã ngẫu nhiên dạng PASS + 6 số
    const randomCode = "PASS" + Math.floor(100000 + Math.random() * 900000);
    
    // Mã có hiệu lực trong 5 phút
    activeCodes[randomCode] = {
        campaignId: campaignId || "DEFAULT",
        expires: Date.now() + 5 * 60 * 1000
    };

    console.log(`[+] Đã sinh mã mới: ${randomCode}`);
    res.json({ success: true, code: randomCode });
});

// 3. API kiểm tra mã khi người dùng nộp mã
app.post('/api/submit-code', (req, res) => {
    const { userId, code } = req.body;

    if (!activeCodes[code]) {
        return res.json({ success: false, message: "Mã không đúng hoặc đã hết hạn!" });
    }

    if (Date.now() > activeCodes[code].expires) {
        delete activeCodes[code];
        return res.json({ success: false, message: "Mã đã quá hạn 5 phút!" });
    }

    // Đúng mã -> Xóa mã ngay lập tức để không bị dùng lại
    delete activeCodes[code];

    // Cộng 300đ cho người dùng
    if (!users[userId]) users[userId] = { balance: 0 };
    users[userId].balance += 300;

    console.log(`[+] Người dùng ${userId} nộp mã đúng! Số dư hiện tại: ${users[userId].balance}đ`);
    res.json({ 
        success: true, 
        message: "Chúc mừng! Bạn đã nhận được 300đ", 
        newBalance: users[userId].balance 
    });
});

// Khởi động máy chủ ở cổng 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
});