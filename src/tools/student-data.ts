/** Shared classification for authorization, private history and replay policy. */
export function isPrivateTool(id: string): boolean {
  return [
    'get_grades',
    'get_grades_by_course',
    'get_student_info',
    'get_academic_result',
    'get_exams',
  ].includes(id);
}
