# -*- coding: utf-8 -*-
"""Sinh eval/golden-v1.json từ bản nháp bên dưới và kiểm tra tự động:
 1. mỗi cụm trong `answers` phải có nguyên văn trong văn bản nguồn (chuẩn hóa như retrieval.ts)
 2. câu no_answer: các từ khóa trong `absent` không được xuất hiện ở BẤT KỲ văn bản nào
Chạy (từ HustVA-BE): python -X utf8 eval/build_golden.py .local/crawler eval/golden-v1.json
"""
import json, re, sys, unicodedata, collections

DOCS = {
    'qc2025': '23e386c986782f67632e5e278875dac7d602c27becf5b3fdc78bcf7a31e5b0fc',
    'hp2627': '89774fc28348d6f105ff53b507065574dc65ad2f8b20d38dbc083e2111ba0a59',
    'hp2526': 'd192981b98856c9ffcd941afdb06628d938732c5adaf75cc8a5f77b3db4bc917',
    'nnK71': '42360bb0a3b1d0855b6645e6a62f8870869261b0ad80050f2e32c54e9b9f2075',
    'kkht': 'ae4aebbd41933c83fadf91251bf1c88c09dd3381476a5b27361ee1c512ff1923',
    'libfaq': 'a03556e32a65ae4b8606168426eb51b4e8a72a34b4fa5348f7e1c3a321d71934',
    'libhours': 'bd6410acf07edbdf0680e6c017b4f4e6072798758b26076ce3001e30dfa99ad3',
    'libborrow': 'ed81f3e2d28cc557a7b1d2224988b98c975328efd8d5ec8078c9aa83bb908c85',
    'libgroup': '1f0f9b2579e23b2e0ebd85f26cb80b644b364e41369eaf1a79599d96e1f0bb86',
    'diemliet': 'd6c897749ceea389fad2680b0744be5248b422faeac29b78ef4875410613f790',
    'bangmat': 'a0b76f3f119b6a2e512e5bdceb5f22381166107f03748ef55317ee2e7baecd48',
    'thanhtoan': '423bd367300182e830085a454f0f43b501d1145d7771c70dad818f6110fb4666',
}

# (id, type, expected_behavior, topic, question, [(docKey, answer phrase)], reference, note, absent_patterns)
Q = [
# ---------------- simple: tra cứu 1 đoạn, câu hỏi viết theo kiểu sinh viên ----------------
('s01','simple','answer','Đăng ký học',
 '1 kỳ chính em đc đăng ký tối đa bao nhiêu tín?',
 [('qc2025','được đăng ký tối đa 24 TC và tối thiểu 12 TC trong học kỳ chính')],
 'Tối đa 24 TC, tối thiểu 12 TC mỗi học kỳ chính (năm cuối không áp dụng mức tối thiểu). Sinh viên đang bị cảnh báo học tập bị giới hạn riêng.',
 'QC2025 Điều 10.2a', None),
('s02','simple','answer','Đăng ký học',
 'ki he dc dang ky toi da may tin a',
 [('qc2025','Sinh viên được đăng ký tối đa 8 TC trong học kỳ hè')],
 'Tối đa 8 TC trong học kỳ hè.',
 'QC2025 Điều 10.2a. Viết không dấu để thử retriever.', None),
('s03','simple','answer','Điểm, đánh giá',
 'Nghỉ học 5 buổi thì bị trừ bao nhiêu điểm quá trình?',
 [('qc2025','Số lần vắng mặt : 0 1 - 2 3 - 4 ≥ 5'), ('qc2025','Điểm quá trình được cộng/trừ: +1 0 - 1 - 2')],
 'Vắng từ 5 lần trở lên bị trừ 2 điểm quá trình (0 lần: +1; 1–2 lần: 0; 3–4 lần: −1).',
 'QC2025 Điều 5.2. Bảng trong PDF bị tách dòng, đáp án nằm ở 2 dòng liền nhau.', None),
('s04','simple','answer','Thi, phúc tra',
 'Muốn phúc khảo điểm thì phải nộp đơn trong bao lâu?',
 [('qc2025','trong thời hạn 7 ngày kể từ khi điểm học phần được cập nhật vào tài khoản học tập')],
 'Trong 7 ngày kể từ khi điểm học phần được cập nhật vào tài khoản. Không áp dụng với học phần thi vấn đáp hoặc đánh giá trước hội đồng.',
 'QC2025 Điều 6.4. Sinh viên nói "phúc khảo", văn bản ghi "phúc tra".', None),
('s05','simple','answer','Điểm, đánh giá',
 'Điểm thi cuối kỳ bao nhiêu thì bị tính là điểm liệt?',
 [('qc2025','Điểm số dưới 3 đối với các học phần khác')],
 'Dưới 3 (thang 10) là điểm liệt với học phần thông thường; với đồ án/khóa luận tốt nghiệp là dưới 5. Có một điểm thành phần liệt thì điểm học phần là F.',
 'QC2025 Điều 5.5–5.6', None),
('s06','simple','answer','Tốt nghiệp',
 'Trường xét tốt nghiệp mấy đợt một năm?',
 [('qc2025','xét tốt nghiệp theo 03 đợt trong năm')],
 '3 đợt mỗi năm: cuối mỗi học kỳ chính và cuối học kỳ hè.',
 'QC2025 Điều 14.1', None),
('s07','simple','answer','Tốt nghiệp',
 'CPA tối thiểu bao nhiêu thì mới được xét tốt nghiệp?',
 [('qc2025','Điểm trung bình tích lũy toàn khóa (tính theo các học phần đăng ký tốt nghiệp) đạt từ 2,0 trở lên')],
 'CPA toàn khóa (tính theo các học phần đăng ký tốt nghiệp) từ 2,0 trở lên, cùng các điều kiện: hoàn thành đủ học phần (kể cả GDTC, GDQP-AN), đạt chuẩn ngoại ngữ đầu ra, không bị truy cứu hình sự/đình chỉ học.',
 'QC2025 Điều 14.3', None),
('s08','simple','answer','Điểm, GPA, CPA',
 'CPA 3.3 thì xếp loại học lực gì?',
 [('qc2025','GPA hoặc CPA < 1,0 1,0 - 1,99 2,0 - 2,49 2,5 - 3,19 3,2 - 3,59 3,6 - 4,0'), ('qc2025','Xếp loại Kém Yếu Trung bình Khá Giỏi Xuất sắc')],
 'Loại Giỏi (CPA 3,2 – 3,59).',
 'QC2025 Điều 12.6. Phải đọc bảng hai dòng để ghép mốc với nhãn.', None),
('s09','simple','answer','Điểm, GPA, CPA',
 'em tích lũy được 70 tín rồi thì tính là sinh viên năm mấy?',
 [('qc2025','Số TCTL < 32 32 - 63 64 - 95 96 - 127 ≥ 128')],
 'Năm thứ ba (64 – 95 TC tích lũy).',
 'QC2025 Điều 12.5', None),
('s10','simple','answer','Cảnh báo, thôi học',
 'Kỳ này em trượt 10 tín thì có bị cảnh báo học tập không?',
 [('qc2025','Nâng một mức cảnh báo học tập đối với sinh viên có số TC không đạt trong học kỳ lớn hơn 8')],
 'Có. Số TC không đạt trong học kỳ lớn hơn 8 thì bị nâng một mức cảnh báo (lớn hơn 16 thì nâng hai mức).',
 'QC2025 Điều 19.1a-b', None),
('s11','simple','answer','Cảnh báo, thôi học',
 'Trường hợp nào thì sinh viên bị buộc thôi học vì học kém?',
 [('qc2025','Sinh viên bị cảnh báo học tập mức 3 lần thứ hai liên tiếp')],
 'Bị cảnh báo mức 3 lần thứ hai liên tiếp; hoặc học chậm tiến độ quá thời gian cho phép / không còn khả năng tốt nghiệp trong thời gian cho phép.',
 'QC2025 Điều 19.3', None),
('s12','simple','answer','Học phí',
 'rút môn trong 7 tuần đầu thì có phải đóng học phí môn đó ko?',
 [('qc2025','chỉ đóng một nửa (50%) học phí của học phần đó')],
 'Nếu được duyệt thì chỉ đóng 50% học phí học phần đó; rút trong tuần đầu của học kỳ 2 thì không phải đóng. Không áp dụng cho kỳ hè.',
 'QC2025 Điều 9.3', None),
('s13','simple','answer','Đăng ký học',
 'Điều kiện để được mở lớp học phần rút gọn là gì?',
 [('qc2025','Sinh viên đã học học phần đó ít nhất 02 lần nhưng chưa đạt'), ('qc2025','Điểm quá trình của học phần phải từ 2 điểm trở lên trong lần học gần nhất')],
 'Thỏa đồng thời: đã học học phần ít nhất 2 lần chưa đạt; điểm quá trình lần gần nhất từ 2 trở lên; trình độ từ năm thứ ba trở lên. Học phí lớp rút gọn bằng 50%.',
 'QC2025 Điều 10.5, Điều 9.5', None),
('s14','simple','answer','Chuyển ngành, song bằng',
 'Muốn chuyển ngành thì cần CPA bao nhiêu?',
 [('qc2025','Xếp loại học lực căn cứ theo điểm trung bình tích lũy (CPA) đạt từ loại khá trở lên')],
 'CPA ≥ 2,5 (loại khá), học hết năm thứ nhất, đáp ứng điều kiện trúng tuyển của CTĐT mới, không bị cảnh báo học tập, không đang bị kỷ luật.',
 'QC2025 Điều 17.1', None),
('s15','simple','answer','Chuyển ngành, song bằng',
 'Sớm nhất khi nào thì được đăng ký học song bằng?',
 [('qc2025','sớm nhất khi đã được xếp trình độ năm thứ hai của chương trình thứ nhất')],
 'Khi đã được xếp trình độ năm thứ hai của chương trình thứ nhất, CPA từ trung bình trở lên và đáp ứng điều kiện trúng tuyển chương trình thứ hai.',
 'QC2025 Điều 18.2. Sinh viên nói "song bằng", văn bản ghi "học cùng lúc hai chương trình".', None),
('s16','paraphrase','answer','Cảnh báo, thôi học',
 'Em muốn bảo lưu vì lý do cá nhân thì được nghỉ tối đa bao lâu?',
 [('qc2025','Thời gian nghỉ học tối đa cho phép là 04 học kỳ chính')],
 'Phải học ít nhất 1 học kỳ; nghỉ tối đa 4 học kỳ chính và tính vào thời gian chậm tiến độ; quá 4 học kỳ chính sẽ bị xét buộc thôi học.',
 'QC2025 Điều 16.2d. Sinh viên nói "bảo lưu", văn bản ghi "nghỉ học tạm thời".', None),
('s17','paraphrase','answer','Thi, phúc tra',
 'Hôm thi cuối kỳ em bị ốm không đi thi được thì sao ạ?',
 [('qc2025','trong thời hạn 2 học kỳ chính tiếp theo để hoàn thiện điểm')],
 'Được hoãn thi (có lý do chính đáng) và dự thi trong 2 học kỳ chính tiếp theo; quá hạn thì điểm học phần là F. Trong thời gian chờ nhận điểm I.',
 'QC2025 Điều 6.3, 5.9a. Câu kể hoàn cảnh, không dùng từ "hoãn thi".', None),
('s18','simple','answer','Học phí',
 'Học phí ngành Khoa học máy tính năm 2026-2027 là bao nhiêu 1 tín?',
 [('hp2627','KT Cơ điện tử, KT điện tử - viễn thông, KT điều khiển - tự động hóa, Khoa 700 học máy tính')],
 '700 nghìn đồng/tín chỉ học phí (TCHP) cho chương trình chuẩn.',
 'QĐ học phí 2026-2027. Bảng PDF bị vỡ, số 700 chen giữa tên ngành.', None),
('s19','simple','answer','Học phí',
 'Học phí kỳ hè có đắt hơn kỳ chính không?',
 [('hp2627','Mức học phí học kỳ hè được tính bằng 1,5 lần mức học phí')],
 'Có, học phí kỳ hè bằng 1,5 lần mức kỳ chính (trừ một số học phần và CTĐT kỹ sư chuyên sâu).',
 'QĐ học phí 2026-2027, Phụ lục I mục 5', None),
('s20','simple','answer','Thư viện',
 'Mượn giáo trình ở thư viện được mấy cuốn, trong bao lâu?',
 [('libborrow','Số lượng mượn: tối đa 08 cuốn.'), ('libborrow','Thời hạn mượn: 60 ngày')],
 'Phòng mượn giáo trình 111: tối đa 8 cuốn, 60 ngày, mỗi tài liệu gia hạn 1 lần thêm 30 ngày.',
 'Trang "Mượn tài liệu về nhà"', None),
('s21','simple','answer','Thư viện',
 'Cuối tuần phòng tự học thư viện mở đến mấy giờ?',
 [('libhours','8h00- 19h00 ngày thứ 7, chủ nhật')],
 'Phòng tự học 301, 303, 401, 418: thứ 7 và chủ nhật mở 8h00 – 19h00 (ngày thường 8h00 – 21h00).',
 'Trang "Giờ phục vụ"', None),
('s22','paraphrase','answer','Thư viện',
 'Đặt phòng học nhóm mà nhóm em đến muộn thì có bị mất phòng không?',
 [('libgroup','Nếu quá 15 phút không đến, thư viện có quyền hủy lịch')],
 'Có thể mất: quá 15 phút không đến thì thư viện có quyền hủy lịch và giao phòng cho nhóm khác.',
 'Trang "Dịch vụ sử dụng phòng học nhóm"', None),
('s23','simple','answer','Ngoại ngữ',
 'K71 học chương trình chuẩn thì cần tiếng Anh bậc mấy để tốt nghiệp?',
 [('nnK71','(trừ các CTĐT nhóm ngành ngôn ngữ) 3 trở lên theo Bảng 2.1, Phụ lục II')],
 'Có chứng chỉ tiếng Anh quy đổi tương đương từ Bậc 3 trở lên (theo Bảng 2.1, Phụ lục II).',
 'QĐ ngoại ngữ K71, Bảng 3.2. Bảng PDF bị tách dòng.', None),
('s24','simple','answer','Ngoại ngữ',
 'IELTS em thi từ 3 năm trước thì còn dùng xét chuẩn đầu ra được không?',
 [('nnK71','phải được cấp trong vòng 2 năm tính đến thời điểm xét chuẩn ngoại ngữ đầu ra')],
 'Không. Chứng chỉ phải được cấp trong vòng 2 năm tính đến thời điểm xét và còn hiệu lực, đánh giá đủ 4 kỹ năng.',
 'QĐ ngoại ngữ K71, Điều 5.2', None),
('s25','simple','answer','Ngoại ngữ',
 'TOEFL iBT Home Edition có được trường công nhận không?',
 [('nnK71','bao gồm TOEFL iBT Home Edition')],
 'Không. Trường không công nhận chứng chỉ thi trực tuyến tại nhà, bao gồm TOEFL iBT Home Edition.',
 'QĐ ngoại ngữ K71, Phụ lục II mục 2', None),
('s26','simple','answer','Đồ án, tốt nghiệp',
 'Điểm giảng viên hướng dẫn đồ án dưới 5 thì có được bảo vệ không?',
 [('qc2025','thì sinh viên không được phép tham gia bảo vệ ĐATN')],
 'Không. Điểm người hướng dẫn hoặc phản biện dưới 5 thì không được bảo vệ, điểm bảo vệ tính là 0.',
 'QC2025 Điều 13.2c', None),
('s27','paraphrase','answer','Thẻ, giấy tờ, thủ tục',
 'Em làm mất bằng đại học rồi, giờ phải làm sao?',
 [('bangmat','Phải có giấy tường trình về việc mất trộm có xác nhận của công an')],
 'Xin giấy chứng nhận tốt nghiệp thay bằng: cần giấy tường trình có xác nhận của công an và CMND/CCCD; nhận giấy sau 3 ngày kể từ khi nộp.',
 'Thông báo của Phòng Đào tạo (văn bản cũ, cần xác nhận còn hiệu lực).', None),
('s28','simple','answer','Học bổng',
 'GPA 3.4, điểm rèn luyện 85 thì đủ điều kiện học bổng KKHT loại nào?',
 [('kkht','Học bổng loại B: GPA ≥ 3,2 và điểm rèn luyện học kỳ ≥ 80 điểm')],
 'Đủ tiêu chuẩn loại B (Giỏi): GPA ≥ 3,2 và ĐRL ≥ 80. Chưa đủ loại A (cần GPA ≥ 3,6, ĐRL ≥ 90). Việc có nhận được hay không còn phụ thuộc quỹ và xếp hạng theo khóa/ngành.',
 'Quy định KKHT 2020 (QĐ 2124). Văn bản năm 2020, cần nghiệp vụ xác nhận còn áp dụng.', None),
('s29','simple','answer','Học bổng',
 'Bao giờ thì có danh sách học bổng KKHT?',
 [('kkht','chậm nhất vào tuần học thứ 10 của học kỳ cấp học bổng')],
 'Chậm nhất vào tuần học thứ 10 của học kỳ cấp học bổng.',
 'Quy định KKHT 2020, Điều 5.1', None),

# ---------------- multi_hop: phải ghép >= 2 đoạn / tính toán ----------------
('m01','multi_hop','answer','Đăng ký học',
 'Em học chương trình chuẩn, đang bị cảnh báo mức 2. Kỳ hè và kỳ 1 năm sau em đăng ký được tối đa bao nhiêu tín?',
 [('qc2025','Sinh viên thuộc các CTĐT chuẩn được đăng ký tối đa 14 TC và tối thiểu 8 TC'), ('qc2025','Sinh viên được đăng ký tối đa 8 TC trong học kỳ hè')],
 'Kỳ hè: tối đa 8 TC. Học kỳ 1 năm sau: tối đa 14 TC, tối thiểu 8 TC (vì đang bị cảnh báo từ mức 2).',
 'Ghép Điều 10.2a và Điều 19.2a.', None),
('m02','multi_hop','answer','Học phí',
 'Em học Khoa học máy tính, kỳ hè 2026-2027 học 1 tín thì mất bao nhiêu tiền?',
 [('hp2627','KT Cơ điện tử, KT điện tử - viễn thông, KT điều khiển - tự động hóa, Khoa 700 học máy tính'), ('hp2627','Mức học phí học kỳ hè được tính bằng 1,5 lần mức học phí')],
 '700 × 1,5 = 1.050 nghìn đồng/TCHP (khoảng 1,05 triệu đồng mỗi tín chỉ học phí).',
 'Ghép 2 mục trong cùng quyết định rồi tính. Kiểm tra bot có tính đúng không.', None),
('m03','multi_hop','answer','Học phí',
 'Đồ án tốt nghiệp 12 tín của ngành KHMT năm 2026-2027 thì học phí bao nhiêu?',
 [('hp2627','Khóa luận tốt nghiệp, đồ án tốt nghiệp 1 TCHT = 2,5 TCHP'), ('hp2627','KT Cơ điện tử, KT điện tử - viễn thông, KT điều khiển - tự động hóa, Khoa 700 học máy tính')],
 '12 TC × 2,5 = 30 TCHP; 30 × 700 nghìn = 21.000.000 đồng.',
 'Phải biết quy đổi TCHT sang TCHP (Phụ lục II) rồi nhân mức học phí (Phụ lục I).', None),
('m04','multi_hop','answer','Tốt nghiệp, hạng bằng',
 'CPA em 3.65 nhưng phải học lại 10 tín trên tổng 132 tín, thì em tốt nghiệp bằng gì?',
 [('qc2025','Khối lượng của các học phần phải học lại vượt quá 5% của tổng số TC'), ('qc2025','GPA hoặc CPA < 1,0 1,0 - 1,99 2,0 - 2,49 2,5 - 3,19 3,2 - 3,59 3,6 - 4,0')],
 '10/132 ≈ 7,6% > 5% nên bị giảm một mức: từ Xuất sắc xuống Giỏi (áp dụng với khóa tuyển sinh từ 2022).',
 'Ghép Điều 15.2a, bảng xếp loại Điều 12.6 và hiệu lực Điều 48.2a.', None),
('m05','multi_hop','answer','Điểm, đánh giá',
 'Em vắng 5 buổi, điểm quá trình gốc là 4 thì có bị F không?',
 [('qc2025','Điểm quá trình được cộng/trừ: +1 0 - 1 - 2'), ('qc2025','Điểm số dưới 3 đối với các học phần khác')],
 'Bị trừ 2 điểm nên điểm quá trình còn 2, dưới 3 là điểm liệt, nên điểm học phần là F.',
 'CẦN NGHIỆP VỤ XÁC NHẬN: quy chế không nói rõ điểm liệt xét trước hay sau khi trừ điểm chuyên cần.', None),
('m06','multi_hop','answer','Thư viện',
 'Em sắp tốt nghiệp, đang mượn sách ở phòng 111, em cần làm gì với thư viện và đi hôm nào được?',
 [('thanhtoan','cần đề nghị trực tiếp với cán bộ phòng mượn khóa tài khoản'), ('libborrow','Sáng thứ 3 và sáng thứ 6 không phục vụ')],
 'Trả hết sách đang mượn tại phòng 111, xử lý đền/vi phạm nếu có, đề nghị cán bộ khóa tài khoản để hoàn tất công nợ. Phòng 111 mở 8h–12h và 13h30–17h30, nhưng không phục vụ sáng thứ 3 và sáng thứ 6.',
 'Ghép trang "Thủ tục thanh toán ra trường" và trang "Mượn tài liệu về nhà".', None),
('m07','multi_hop','answer','Học phí',
 'Tuần thứ 5 của kỳ em xin bảo lưu thì học phí kỳ đó tính thế nào?',
 [('qc2025','sẽ bị hủy và tính học phí theo quy định tại khoản 4 Điều 9'), ('qc2025','phải đóng một nửa (50%) học phí của học kỳ đó')],
 'Các học phần đã đăng ký bị hủy; nộp đơn trong 7 tuần đầu và được duyệt thì đóng 50% học phí học kỳ đó (không áp dụng kỳ hè; trường hợp ốm/thai sản/nghĩa vụ quân sự do Giám đốc quyết định).',
 'Điều 16.4 dẫn chiếu sang Điều 9.4, nên retriever phải lấy được cả 2 đoạn.', None),
('m08','multi_hop','answer','Học bổng',
 'Kỳ trước em có 1 môn bị F nhưng GPA vẫn 3.2, rèn luyện 90, em có được học bổng KKHT không?',
 [('kkht','Có học phần đạt điểm F tại học kỳ lấy điểm xét cấp học bổng')],
 'Không. Có học phần điểm F trong học kỳ xét thì không được xét học bổng, dù GPA và ĐRL đủ tiêu chuẩn.',
 'Lấy từ câu hỏi thật số 12 trong CSV gốc. Phải đối chiếu tiêu chuẩn (Điều 3) với các trường hợp loại trừ (Điều 4.5).', None),
('m09','multi_hop','answer','Học bổng',
 'GPA 3.5, rèn luyện 80 thì điểm xét học bổng KKHT của em là bao nhiêu?',
 [('kkht','Điểm xét học bổng = [(GPA x 2) + (Điểm rèn luyện: 25)] : 3')],
 '(3,5 × 2 + 80 : 25) : 3 = (7 + 3,2) : 3 = 3,40.',
 'Kiểm tra bot áp dụng công thức và tính đúng.', None),

# ---------------- false_premise: câu hỏi chứa giả định sai ----------------
('f01','false_premise','correct_premise','Đăng ký học',
 'Kỳ hè được đăng ký tối đa 12 tín đúng không ạ?',
 [('qc2025','Sinh viên được đăng ký tối đa 8 TC trong học kỳ hè')],
 'Không đúng. Kỳ hè tối đa 8 TC.',
 'Đổi số 8 thành 12.', None),
('f02','false_premise','correct_premise','Thi, phúc tra',
 'Trượt môn thì lịch thi lại lần 2 là khi nào?',
 [('qc2025','và không có lần thi lại')],
 'Không có thi lại. Mỗi học phần chỉ thi cuối kỳ 1 lần; trượt thì phải đăng ký học lại.',
 'Giả định sai rằng có thi lại. Bot dễ bịa lịch thi lại.', None),
('f03','false_premise','correct_premise','Ngoại ngữ',
 'Em thi HUST English Placement Test được 600 điểm, vậy là đủ chuẩn đầu ra tiếng Anh rồi đúng không?',
 [('nnK71','không được sử dụng để xét đạt chuẩn ngoại ngữ đầu ra')],
 'Không. Kết quả HUST English Placement Test chỉ dùng để phân loại, xếp lớp và xét miễn học phần ngoại ngữ cơ bản, không dùng để xét chuẩn đầu ra.',
 'QĐ ngoại ngữ K71, ghi chú Bảng 3.1', None),
('f04','false_premise','correct_premise','Học phí',
 'Rút môn kỳ hè trong 7 tuần đầu thì được giảm 50% học phí phải không?',
 [('qc2025','Quy định tại khoản này không áp dụng với các học phần học ở học kỳ hè')],
 'Không. Quy định đóng 50% khi rút học phần không áp dụng cho kỳ hè.',
 'Quy định có thật nhưng bị áp sai phạm vi.', None),
('f05','false_premise','correct_premise','Cảnh báo, thôi học',
 'Bị cảnh báo mức 3 là bị đuổi học luôn à?',
 [('qc2025','Sinh viên bị cảnh báo học tập mức 3 lần thứ hai liên tiếp')],
 'Không. Chỉ bị buộc thôi học khi bị cảnh báo mức 3 lần thứ hai liên tiếp. Nếu nợ đọng giảm về ≤ 24 TC thì được hạ xuống mức 2.',
 'QC2025 Điều 19.1đ, 19.3a', None),
('f06','false_premise','correct_premise','Thư viện',
 'Mượn sách tham khảo ở phòng 102 được giữ 60 ngày đúng không?',
 [('libborrow','Thời hạn mượn: tối đa 30 ngày.')],
 'Không. Phòng 102 cho mượn tối đa 5 cuốn trong 30 ngày, gia hạn 7 ngày. Mức 60 ngày là của phòng giáo trình 111.',
 'Lẫn quy định của 2 phòng.', None),
('f07','false_premise','correct_premise','Thi, phúc tra',
 'Em muốn phúc khảo điểm môn thi vấn đáp thì nộp đơn ở đâu?',
 [('qc2025','Không áp dụng phúc tra hoặc khiếu nại điểm với các học phần được tổ chức thi theo hình thức vấn đáp')],
 'Không phúc tra được: quy chế không áp dụng phúc tra/khiếu nại với học phần thi vấn đáp hoặc đánh giá trước hội đồng.',
 'Tiền đề ngầm: thi vấn đáp cũng phúc tra được.', None),
('f08','false_premise','correct_premise','Chuyển ngành, song bằng',
 'Chuyển ngành chỉ cần CPA 2.0 là đủ đúng không?',
 [('qc2025','Xếp loại học lực căn cứ theo điểm trung bình tích lũy (CPA) đạt từ loại khá trở lên')],
 'Không. Cần CPA ≥ 2,5 (loại khá) cùng các điều kiện khác.',
 'Đổi 2,5 thành 2,0.', None),

# ---------------- no_answer: tài liệu KHÔNG có (đã grep toàn bộ kho) ----------------
('n01','no_answer','refuse','Học phí',
 'Học phí có được trả góp theo tháng không?', [],
 'Tài liệu không có thông tin này.', 'Đã kiểm tra: không văn bản nào nhắc "trả góp".', ['trả góp']),
('n02','no_answer','refuse','Thư viện',
 'Mật khẩu wifi ở thư viện là gì vậy?', [],
 'Tài liệu không có thông tin này.', 'Có văn bản nhắc "mật khẩu" (tài khoản bạn đọc), nên bot dễ trả lời nhầm.', ['wifi', 'wi-fi']),
('n03','no_answer','refuse','KTX, cơ sở vật chất',
 'Ký túc xá giá phòng bao nhiêu một tháng?', [],
 'Tài liệu không có thông tin này.', 'Kho chưa crawl trang về ký túc xá.', ['ký túc', 'KTX']),
('n04','no_answer','refuse','KTX, cơ sở vật chất',
 'Gửi xe máy trong trường mất bao nhiêu tiền?', [],
 'Tài liệu không có thông tin này.', '', ['gửi xe', 'bãi xe']),
('n05','no_answer','refuse','KTX, cơ sở vật chất',
 'Căng tin mấy giờ mở cửa?', [],
 'Tài liệu không có thông tin này.', '', ['căng tin', 'canteen', 'nhà ăn']),
('n06','no_answer','refuse','Tuyển sinh',
 'Điểm chuẩn ngành Khoa học máy tính năm 2026 là bao nhiêu?', [],
 'Tài liệu không có thông tin này.', 'Quy chế 2018 có nhắc "điểm chuẩn" nhưng không có điểm chuẩn tuyển sinh, bot dễ lấy nhầm.', ['điểm chuẩn tuyển sinh', 'điểm trúng tuyển']),
('n07','no_answer','refuse','Thư viện',
 'Thư viện có cho mượn laptop không?', [],
 'Tài liệu không có thông tin này.', '', ['laptop', 'máy tính xách tay']),
('n08','no_answer','refuse','Thẻ, giấy tờ, thủ tục',
 'Mất thẻ sinh viên thì làm lại ở đâu, mất bao nhiêu tiền?', [],
 'Tài liệu không có quy trình làm lại thẻ sinh viên. Chỉ có hướng dẫn của thư viện: báo mất cho thư viện, phòng CTSV, phòng Bảo vệ; tạm dùng giấy xác nhận sinh viên.',
 'Bẫy gần đúng: FAQ thư viện chỉ nói về mất thẻ trong phạm vi thư viện. Bot nên nói rõ tài liệu chỉ có phần này.', ['mất thẻ sinh viên', 'cấp lại thẻ sinh viên']),

# ---------------- ambiguous: cần hỏi lại ----------------
('a01','ambiguous','clarify','Học phí',
 'Học phí bao nhiêu?', [],
 'Cần hỏi lại: ngành/chương trình (chuẩn, ELITECH, hợp tác quốc tế...), năm học, hệ (chính quy, VLVH, sau đại học), kỳ chính hay kỳ hè.',
 'Câu quá chung, có hàng chục mức học phí.', None),
('a02','ambiguous','clarify','Cảnh báo, thôi học',
 'Bị cảnh báo thì đăng ký được bao nhiêu tín?', [],
 'Cần hỏi lại mức cảnh báo và chương trình: mức 1 không bị giới hạn (24 TC); từ mức 2, CTĐT chuẩn tối đa 14 TC, ELITECH/hợp tác quốc tế tối đa 18 TC (tối thiểu 8 TC).',
 'Bot có thể hỏi lại hoặc liệt kê đủ các trường hợp. Trả lời đúng một con số là sai.', None),
('a03','ambiguous','clarify','Ngoại ngữ',
 'Chuẩn đầu ra tiếng Anh là bao nhiêu?', [],
 'Cần hỏi lại khóa và chương trình: ví dụ K71 chương trình chuẩn cần Bậc 3, ELITECH và tài năng cần Bậc 4; khóa cũ theo quy định riêng.',
 '', None),
('a04','ambiguous','clarify','Thư viện',
 'Thư viện mở cửa đến mấy giờ?', [],
 'Cần hỏi lại phòng và ngày: phòng đọc/mượn 8h–12h, 13h30–17h30 thứ 2–6; phòng tự học đến 21h (thứ 2–6) và 19h (thứ 7, CN).',
 '', None),

# ---------------- conflict: tài liệu mâu thuẫn hoặc có nhiều phiên bản ----------------
('c01','conflict','answer_with_caveat','Thư viện',
 'Buổi chiều thư viện đóng cửa lúc mấy giờ?',
 [('libhours','Chiều: 13h30 – 17h30'), ('libfaq','Chiều: 13h30 đến 17h00.')],
 'Trang "Giờ phục vụ" ghi 13h30–17h30, trang FAQ ghi 13h30–17h00. Bot nên nêu theo trang Giờ phục vụ (chi tiết hơn) hoặc nói rõ có hai thông tin khác nhau.',
 'Mâu thuẫn có thật trong kho. Người duyệt cần chốt nguồn ưu tiên.', None),
('c02','conflict','answer_with_caveat','Điểm, đánh giá',
 'Điểm thực tập tốt nghiệp dưới 5 có bị liệt không?',
 [('qc2025','Điểm số dưới 3 đối với các học phần khác'), ('diemliet','điểm hướng dẫn, điểm phản biện và điểm bảo vệ hội đồng đạt dưới 5,0 là điểm liệt')],
 'Theo Quy chế 2025 (đang hiệu lực), điểm liệt dưới 5 chỉ áp dụng cho đồ án/khóa luận tốt nghiệp; thực tập tốt nghiệp thuộc "học phần khác", nên dưới 3 mới liệt. Quy định năm 2013 (dưới 5 là liệt với cả thực tập tốt nghiệp) đã cũ.',
 'Bẫy phiên bản: văn bản 2013 vẫn nằm trong kho.', None),
('c03','conflict','answer_with_caveat','Học phí',
 'Học phí ngành KHMT 1 tín bao nhiêu tiền?',
 [('hp2627','KT Cơ điện tử, KT điện tử - viễn thông, KT điều khiển - tự động hóa, Khoa 700 học máy tính'), ('hp2526','KT Cơ điện tử, KT điện tử - viễn thông, KT điều khiển - tự động 630 hóa, Khoa học máy tính')],
 'Năm học 2026-2027 (hiện tại): 700 nghìn đồng/TCHP. Năm 2025-2026 là 630 nghìn. Bot phải ưu tiên năm hiện hành và nêu rõ năm học.',
 'Kho có học phí nhiều năm, bot dễ lấy nhầm năm cũ.', None),
('c04','conflict','answer_with_caveat','Cảnh báo, thôi học',
 'Em được phép học ở trường lâu nhất là bao lâu?',
 [('qc2025','thời gian chậm tiến độ không được vượt quá 5 học kỳ chính đối với các chương'), ('qc2025','thời gian tối đa được phép học tại ĐHBK Hà Nội không quá 2 lần thời gian theo kế hoạch học tập chuẩn')],
 'Cử nhân được chậm tối đa 5 học kỳ chính so với kế hoạch chuẩn (kỹ sư, thạc sĩ: 2 học kỳ chính). Mức "không quá 2 lần thời gian chuẩn" chỉ dành cho đối tượng ưu tiên theo quy chế tuyển sinh.',
 'golden.json cũ (qc-thoi-gian-toi-da) đang lấy nhầm điều khoản của đối tượng ưu tiên làm đáp án chung.', None),
]


def norm(t):
    return unicodedata.normalize('NFC', re.sub(r'\s+', '', t)).lower()


def load_corpus(path):
    """Đọc thẳng kho crawl (.local/crawler: latest/<doc>.json -> versions/<doc>/<version>.json)."""
    import glob, os
    docs = {}
    for p in glob.glob(os.path.join(path, 'latest', '*.json')):
        key = os.path.basename(p)[:-5]
        version = json.load(open(p, encoding='utf-8'))['versionId']
        d = json.load(open(os.path.join(path, 'versions', key, f'{version}.json'), encoding='utf-8'))
        docs[d['documentId']] = {'id': d['documentId'], 'url': d['url'], 'title': d.get('title') or '', 'text': d.get('text') or ''}
    return docs


def main(corpus_path, out_path):
    docs = load_corpus(corpus_path)
    normed = {i: norm(d['text']) for i, d in docs.items()}
    errors, out = [], []
    ids = [q[0] for q in Q]
    dup = [i for i, c in collections.Counter(ids).items() if c > 1]
    if dup:
        errors.append(f'trùng id: {dup}')
    for (qid, typ, beh, topic, question, ans, ref, note, absent) in Q:
        sources, answers = [], []
        for key, phrase in ans:
            doc_id = DOCS[key]
            if norm(phrase) not in normed[doc_id]:
                errors.append(f'{qid}: KHÔNG thấy nguyên văn trong {key}: {phrase!r}')
            hits = sum(1 for t in normed.values() if norm(phrase) in t)
            answers.append(phrase)
            if doc_id not in [s['documentId'] for s in sources]:
                sources.append({'documentId': doc_id, 'url': docs[doc_id]['url']})
        if typ == 'no_answer':
            for pat in absent:
                found = [docs[i]['title'][:50] for i, t in docs.items() if pat.lower() in t['text'].lower()]
                if found:
                    errors.append(f'{qid}: từ khóa {pat!r} lại CÓ trong {found[:3]}')
        out.append({
            'id': qid, 'question': question, 'type': typ, 'expected_behavior': beh,
            'topic': topic, 'answers': answers, 'reference': ref, 'sources': sources, 'note': note,
        })
    counts = collections.Counter(q['type'] for q in out)
    golden = {
        'version': 'v1-draft',
        'createdAt': '2026-11-26',
        'description': (
            'Bộ câu hỏi kiểm thử sinh từ tài liệu đã crawl. answers: cụm trích nguyên văn (so khớp bỏ khoảng trắng, '
            'không phân biệt hoa thường) dùng chấm retrieval; reference: đáp án chuẩn ngắn dùng chấm câu trả lời; '
            'expected_behavior: answer | correct_premise | refuse | clarify | answer_with_caveat. '
            'Câu no_answer/ambiguous có answers rỗng, phải loại khỏi phép tính Hit@k.'
        ),
        'stats': dict(counts),
        'questions': out,
    }
    json.dump(golden, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print('Tổng:', len(out), dict(counts))
    print('Lỗi:' if errors else 'Không có lỗi kiểm tra.')
    for e in errors:
        print(' -', e)
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
