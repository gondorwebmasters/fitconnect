import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { UserRole } from '../../entities/UserRole';
import { PermissionService } from '../permission.service';

/**
 * Tests del seam PermissionService.getLoginPermissionsContext para Session
 * Packs — issue #108: `remainingCredits` viaja en el contexto de login
 * (y de ahí al auth payload de login / getMe).
 */
describe('PermissionService.getLoginPermissionsContext — remainingCredits', () => {
  let service: PermissionService;
  let mockEm: any;
  let user: User;
  let activeSubscription: any;

  function buildSubscription(overrides: Record<string, any> = {}) {
    const sub = new Subscription();
    Object.assign(sub, {
      id: 'sub-1',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date(Date.now() - 86400000),
      currentPeriodEnd: new Date(Date.now() + 86400000 * 20),
      cancelAtPeriodEnd: true,
      plan: {
        id: 'plan-1',
        name: 'Bono 4',
        amount: 0,
        currency: 'eur',
        interval: 'month',
        planPermissions: { getItems: () => [] },
      },
      ...overrides,
    });
    return sub;
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    user.isSuperAdmin = false;
    activeSubscription = null;

    mockEm = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === UserRole) return null; // miembro normal
        if (entity === Subscription) return activeSubscription;
        return null;
      }),
      find: jest.fn(async () => []),
      flush: jest.fn(async () => {}),
    };

    service = new PermissionService(mockEm as any);
  });

  it('exposes remainingCredits = creditsTotal − creditsUsed for a pack', async () => {
    activeSubscription = buildSubscription({ creditsTotal: 4, creditsUsed: 1 });

    const ctx = await service.getLoginPermissionsContext(user, 'comp-1');

    expect(ctx.hasActiveSubscription).toBe(true);
    expect(ctx.remainingCredits).toBe(3);
    expect(ctx.renewsAt).toEqual(activeSubscription.currentPeriodEnd);
  });

  it('exposes remainingCredits = 0 when the pack is used up, and access stays active', async () => {
    activeSubscription = buildSubscription({ creditsTotal: 4, creditsUsed: 4 });

    const ctx = await service.getLoginPermissionsContext(user, 'comp-1');

    expect(ctx.hasActiveSubscription).toBe(true);
    expect(ctx.remainingCredits).toBe(0);
  });

  it('exposes remainingCredits = null for an unlimited (time-based) plan', async () => {
    activeSubscription = buildSubscription({
      creditsTotal: null,
      creditsUsed: 0,
    });

    const ctx = await service.getLoginPermissionsContext(user, 'comp-1');

    expect(ctx.hasActiveSubscription).toBe(true);
    expect(ctx.remainingCredits).toBeNull();
  });

  it('exposes remainingCredits = null when there is no active subscription', async () => {
    activeSubscription = null;

    const ctx = await service.getLoginPermissionsContext(user, 'comp-1');

    expect(ctx.hasActiveSubscription).toBe(false);
    expect(ctx.remainingCredits).toBeNull();
  });
});
