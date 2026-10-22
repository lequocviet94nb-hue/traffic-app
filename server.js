const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use(express.static(__dirname));

// 1. Bộ nhớ tạm lưu tài khoản, mã nhiệm vụ và lịch sử rút tiền
let users = {
    "user1": { balance: 0 } // Tài khoản mẫu mặc định
};
let activeCodes = {}; // Lưu mã: { "PASS123": { campaignId, expires } }
let withdrawals = []; // Danh sách yêu cầu rút tiền

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

// 4. API Người dùng yêu cầu Rút Tiền (MoMo / Ngân hàng)
app.post('/api/withdraw', (req, res) => {
    const { userId, method, accountNumber, accountName, amount } = req.body;
    const withdrawAmount = parseInt(amount);

    if (!users[userId]) users[userId] = { balance: 0 };

    if (isNaN(withdrawAmount) || withdrawAmount < 1000) {
        return res.json({ success: false, message: "Số tiền rút tối thiểu là 1.000đ!" });
    }

    if (users[userId].balance < withdrawAmount) {
        return res.json({ success: false, message: `Số dư không đủ! Bạn hiện có ${users[userId].balance}đ.` });
    }

    if (!accountNumber || !accountName) {
        return res.json({ success: false, message: "Vui lòng nhập đầy đủ thông tin tài khoản nhận tiền!" });
    }

    // Trừ số dư của người dùng
    users[userId].balance -= withdrawAmount;

    // Lưu lệnh rút tiền
    const newRequest = {
        id: Date.now().toString(),
        userId,
        method, // 'MoMo' hoặc 'Ngân hàng'
        accountNumber,
        accountName,
        amount: withdrawAmount,
        status: 'PENDING', // PENDING (Chờ duyệt) hoặc COMPLETED (Đã chuyển)
        time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    };

    withdrawals.unshift(newRequest); // Đưa lên đầu danh sách

    console.log(`[💸] Yêu cầu rút tiền mới: ${userId} rút ${withdrawAmount}đ qua ${method}`);
    res.json({ 
        success: true, 
        message: "Gửi yêu cầu rút tiền thành công! Admin sẽ duyệt và chuyển khoản sớm.", 
        newBalance: users[userId].balance 
    });
});

// 5. API Admin: Lấy danh sách yêu cầu rút tiền
app.get('/api/admin/withdrawals', (req, res) => {
    res.json({ 
        withdrawals, 
        users 
    });
});

// 6. API Admin: Xác nhận đã chuyển tiền
app.post('/api/admin/approve', (req, res) => {
    const { id } = req.body;
    const item = withdrawals.find(w => w.id === id);
    if (item) {
        item.status = 'COMPLETED';
        return res.json({ success: true, message: "Đã cập nhật trạng thái: ĐÃ CHUYỂN TIỀN" });
    }
    res.json({ success: false, message: "Không tìm thấy yêu cầu này!" });
});

// Khởi động máy chủ ở cổng 3000 hoặc cổng Render cấp
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
});
