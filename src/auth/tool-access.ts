import { ChatError } from '../chat/contracts.js';
import type { DemoPrincipal } from './demo-service.js';

const trusted = new WeakSet<object>();
export interface ToolAccess {
  kind: 'demo' | 'management';
  principal?: DemoPrincipal;
}
// These factories are called by server adapters only; never deserialize ToolAccess.
export function demoToolAccess(principal: DemoPrincipal): ToolAccess {
  const access: ToolAccess = Object.freeze({ kind: 'demo', principal });
  trusted.add(access);
  return access;
}
export function managementToolAccess(): ToolAccess {
  const access: ToolAccess = Object.freeze({ kind: 'management' });
  trusted.add(access);
  return access;
}
export async function authorizeGrade(studentId: unknown, access?: ToolAccess) {
  if (!access || !trusted.has(access))
    throw new ChatError(401, 'DEMO_AUTH_REQUIRED', 'Vui lòng đăng nhập demo.');
  if (access.kind === 'management') return;
  const principal = access.principal;
  if (!principal)
    throw new ChatError(401, 'DEMO_AUTH_REQUIRED', 'Vui lòng đăng nhập demo.');
  await principal.validate();
  if (principal.studentId !== studentId)
    throw new ChatError(
      403,
      'HUST_STUDENT_FORBIDDEN',
      'Bạn chỉ được tra cứu điểm của tài khoản đang đăng nhập.',
    );
}
