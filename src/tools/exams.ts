import { z } from 'zod';
import { gradeSemesterSchema, courseIdSchema } from './grades.js';
import { UpstreamError } from './contracts.js';

// studentId is supplied by ToolManager from trusted server-side identity only.
export const examsInputSchema = z.strictObject({
  semester: gradeSemesterSchema,
});
const sourceText = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !/[\p{Cc}\p{Cf}]|\[\[|https?:|www\.|@|mongodb(?:\+srv)?:|AIza/iu.test(
        value,
      ),
  );
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? null : value),
  sourceText.nullish(),
);
const scalar = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? null : value),
  z.union([sourceText, z.number().finite()]).nullish(),
);
const timestamp = z
  .number()
  .int()
  .refine((value) => Number.isFinite(new Date(value).getTime()))
  .nullish();
const examRowSchema = z.object({
  courseId: courseIdSchema,
  courseName: optionalText,
  examDate: timestamp,
  endDate: timestamp,
  dateStr: optionalText,
  endDateStr: optionalText,
  place: optionalText,
  examGroup: scalar,
  examType: scalar,
  typeName: optionalText,
  session: scalar,
  notes: optionalText,
});
const examsSchema = z.array(examRowSchema).max(10_000);
export type ExamRow = z.infer<typeof examRowSchema>;

export function normalizeExams(data: unknown): ExamRow[] | null {
  if (data === null) return null;
  const parsed = examsSchema.safeParse(data);
  if (!parsed.success) throw new UpstreamError('HUST_EXAMS_DATA_INVALID');
  return parsed.data.map((row) => ({
    ...row,
    courseId: row.courseId.toUpperCase(),
  }));
}

const localTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function parts(timestamp: number) {
  const values = Object.fromEntries(
    localTime.formatToParts(new Date(timestamp)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${values.day}/${values.month}/${values.year}`,
    time: `${values.hour}:${values.minute}`,
  };
}
function sourceMismatch(
  timestamp: number | null | undefined,
  source: string | null | undefined,
): boolean {
  if (timestamp == null || !source) return false;
  // Compare only unambiguous source forms; never parse arbitrary upstream date strings.
  const vn =
    /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?$/u.exec(
      source,
    );
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?$/u.exec(
      source,
    );
  const date = vn
    ? `${vn[1]}/${vn[2]}/${vn[3]}`
    : iso
      ? `${iso[3]}/${iso[2]}/${iso[1]}`
      : undefined;
  const match = vn ?? iso;
  const expected = parts(timestamp);
  return Boolean(
    date &&
    (date !== expected.date ||
      (match?.[4] && `${match[4]}:${match[5]}` !== expected.time)),
  );
}
const escape = (value: unknown) =>
  (value == null ? 'Chưa có dữ liệu' : String(value)).replace(
    /[\\|`*_[\]<>!()]/gu,
    '\\$&',
  );

export function renderExams(
  data: unknown,
  semester: string,
  options: { upcoming?: boolean; now?: number } = {},
): string | undefined {
  let rows: ExamRow[] | null;
  try {
    rows = normalizeExams(data);
  } catch {
    return;
  }
  if (!rows?.length) return;
  const sourceCount = rows.length;
  const now = options.now ?? Date.now();
  const unknownTimes = rows.filter((row) => row.examDate == null).length;
  if (options.upcoming) {
    rows = rows.filter((row) => row.examDate == null || row.examDate >= now);
    if (!rows.length)
      return `Trong ${sourceCount} buổi HUST trả về cho **học kỳ ${semester}**, chưa thấy buổi thi nào bắt đầu từ thời điểm hiện tại.\n\nKết quả chỉ trong học kỳ này và dữ liệu API đang có, không khẳng định bạn không còn kỳ thi khác. Bạn kiểm tra thêm thông báo trên cổng sinh viên nhé.`;
  }
  const sorted = [...rows].sort((a, b) => {
    if (a.examDate != null && b.examDate != null && a.examDate !== b.examDate)
      return a.examDate - b.examDate;
    if ((a.examDate == null) !== (b.examDate == null))
      return a.examDate == null ? 1 : -1;
    return (
      a.courseId.localeCompare(b.courseId) ||
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    );
  });
  const lines = [
    `### Lịch thi học kỳ ${semester}`,
    options.upcoming
      ? `Có **${rows.length - unknownTimes} buổi** bắt đầu từ hiện tại trong dữ liệu học kỳ này.${unknownTimes ? ` Có ${unknownTimes} buổi chưa xác định được thời gian, cần kiểm tra thông tin nguồn.` : ''} Giờ Việt Nam (Asia/Ho_Chi_Minh).`
      : `HUST trả về **${rows.length} buổi thi**. Giờ hiển thị theo Việt Nam (Asia/Ho_Chi_Minh).`,
    options.upcoming
      ? 'Chỉ tra trong học kỳ hiện tại; các buổi chưa có timestamp được xếp sau và chưa thể kết luận là sắp thi.'
      : 'Buổi có timestamp được xếp theo thời gian; buổi chỉ có chuỗi ngày nguồn được xếp sau.',
    '| Học phần | Ngày | Giờ | Địa điểm | Nhóm / Ca | Loại thi / Ghi chú |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  let shown = 0;
  for (const row of sorted.slice(0, 30)) {
    const start = row.examDate == null ? undefined : parts(row.examDate);
    const end = row.endDate == null ? undefined : parts(row.endDate);
    const reversed =
      row.examDate != null && row.endDate != null && row.endDate < row.examDate;
    const details =
      [
        row.typeName ?? row.examType,
        row.notes,
        row.dateStr ? `Ngày bắt đầu nguồn: ${row.dateStr}` : undefined,
        row.endDateStr ? `Ngày kết thúc nguồn: ${row.endDateStr}` : undefined,
        reversed
          ? 'Thời gian nguồn chưa nhất quán: kết thúc trước bắt đầu; cần kiểm tra lại.'
          : undefined,
        sourceMismatch(row.examDate, row.dateStr) ||
        sourceMismatch(row.endDate, row.endDateStr)
          ? 'Timestamp và ngày giờ nguồn không khớp; cần kiểm tra lại.'
          : undefined,
      ]
        .filter((v) => v != null)
        .map(escape)
        .join('; ') || 'Chưa có dữ liệu';
    const date =
      start?.date ??
      (row.dateStr ? `Nguồn: ${escape(row.dateStr)}` : 'Chưa có dữ liệu');
    const time = start
      ? `${start.time}${end && !reversed ? ` – ${end.date !== start.date ? `${end.date} ` : ''}${end.time}` : ''}`
      : 'Chưa có dữ liệu';
    const line = `| ${escape(row.courseId)}${row.courseName ? ` — ${escape(row.courseName)}` : ''} | ${date} | ${time} | ${escape(row.place)} | ${escape(row.examGroup)} / ${escape(row.session)} | ${details} |`;
    if (lines.join('\n\n').length + line.length > 8600) break;
    lines.push(line);
    shown++;
  }
  // Keep table rows contiguous; blank lines are needed only before/after the table.
  const tableStart = 3;
  const answer = `${lines.slice(0, tableStart).join('\n\n')}\n\n${lines.slice(tableStart).join('\n')}`;
  return (
    answer +
    (shown < rows.length
      ? `\n\nĐang hiển thị ${shown}/${rows.length} buổi. Danh sách trên chưa hiển thị toàn bộ lịch thi.`
      : '')
  );
}
