import type { Source } from './types.js';

export const sources: Source[] = [
  {
    id: 'ctt-priority',
    name: 'CTT — học phí & ngoại ngữ',
    description: 'Hai bài học phí, ngoại ngữ và PDF đính kèm. Lưu cả nội dung lẫn bản gốc.',
    adapter: 'ctt',
    hosts: ['ctt.hust.edu.vn'],
    seeds: [
      'https://ctt.hust.edu.vn/DisplayWeb/DisplayBaiViet?baiviet=51639',
      'https://ctt.hust.edu.vn/DisplayWeb/DisplayBaiViet?baiviet=51634',
    ],
  },
  {
    id: 'ctt-regulations',
    name: 'CTT — quy chế đại học',
    description: 'Đọc toàn bộ phân trang, bài quy chế, bài liên kết và PDF thuộc nguồn.',
    adapter: 'ctt',
    hosts: ['ctt.hust.edu.vn'],
    seeds: ['https://ctt.hust.edu.vn/DisplayWeb/DisplayQuyChe?tag=%C4%90T%C4%90H'],
  },
  {
    id: 'student-support',
    name: 'HUST — hướng dẫn sinh viên',
    description: 'Học phí, kế hoạch học tập và hướng dẫn sinh viên. Giữ link nguồn để đối chiếu.',
    adapter: 'hust',
    hosts: ['hust.edu.vn', 'www.hust.edu.vn'],
    seeds: [
      'https://hust.edu.vn/vi/sinh-vien/hoc-bong-hoc-phi/hoc-phi-654580.html',
      'https://hust.edu.vn/vi/sinh-vien/ho-tro-sinh-vien/bieu-do-ke-hoach-hoc-tap-654590.html',
      'https://hust.edu.vn/vi/sinh-vien/ho-tro-sinh-vien/nhung-dieu-sinh-vien-can-biet-645447.html',
    ],
  },
  {
    id: 'library',
    name: 'Thư viện — quy định & dịch vụ',
    description:
      'Duyệt danh mục dịch vụ, trợ giúp và phân trang; lấy nội quy, giờ mở cửa, thẻ, mượn trả, gia hạn, biểu mẫu và PDF. Cách mỗi lần tải ít nhất 10 giây.',
    adapter: 'library',
    hosts: ['library.hust.edu.vn'],
    seeds: [
      'https://library.hust.edu.vn/vi/sanpham_dichvu',
      'https://library.hust.edu.vn/vi/page-tr-gi-p',
      'https://library.hust.edu.vn/vi/node/471',
      'https://library.hust.edu.vn/vi/node/1300',
    ],
  },
  {
    id: 'sdh',
    name: 'Sau đại học — kế hoạch học tập',
    description: 'Bài mẫu kế hoạch học tập sau đại học; giữ tham số xác định bài.',
    adapter: 'sdh',
    hosts: ['sdh.hust.edu.vn'],
    seeds: ['https://sdh.hust.edu.vn/Default.aspx?CategoryID=122&nid=3578&scid=23'],
  },
];

export function getSource(id: string): Source {
  const source = sources.find((source) => source.id === id);
  if (!source) throw new Error('Nguồn không có trong danh sách cho phép');
  return source;
}
