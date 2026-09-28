import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { UserRole } from '../../entities/UserRole';
import { PermissionService } from '../permission.service';

/**
 * Tests del payload de auth plural — issue #20 (ADR 0006).
 *
 * `subscriptions[]` es la verdad: una entrada por suscripción vigente, con sus
 * propios créditos. Un `remainingCredits` global no significa nada cuando el
 * miembro sostiene dos Session Packs.
 *
 * Los escalares siguen ahí, **deprecados**, resolviendo de forma determinista y
 * **estable**: comprar un bono no puede cambiar lo que muestra una app antigua.
 */
describe('PermissionService.getLoginPermissionsContext — plural payload', () => {
  let service: PermissionService;
  let mockEm: any;
  let entitlement: any[];
  let user: User;

  /** Un plan sin permisos: aquí solo importa su identidad. */
  function plan(id: string) {
    return {
      id,
      name: `Plan ${id}`,
      amount: 0,
      currency: 'eur',
      interval: 'month',
      planPermissions: {
        init: jest.fn(async () => {}),
        getItems: () => [],
      },
    };
  }

  function subscriptionTo(id: string, planId: string, overrides = {}) {
    const sub = new Subscription();
    Object.assign(sub, {
      id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date(Date.now() - 86400000),
      currentPeriodEnd: new Date(Date.now() + 86400000 * 30),
      trialStart: null,
      trialEnd: null,
      creditsTotal: null,
      creditsUsed: 0,
      cancelAtPeriodEnd: false,
      plan: plan(planId),
      ...overrides,
    });
    return sub;
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    user.isSuperAdmin = false;

    entitlement = [];

    mockEm = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === UserRole) return null;
        return null;
      }),
      find: jest.fn(async (entity: any) => {
        if (entity === Subscription) return entitlement;
        return [];
      }),
      flush: jest.fn(async () => {}),
    };

    service = new PermissionService(mockEm as any);
  });

  describe('subscriptions[]', () => {
    it('should carry one entry per live subscription', async () => {
      entitlement = [
        subscriptionTo('sub-premium', 'premium'),
        subscriptionTo('sub-pack', 'pack', {
          creditsTotal: 10,
          creditsUsed: 4,
        }),
      ];

      const context = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(context.subscriptions.map(s => s.id)).toEqual([
        'sub-premium',
        'sub-pack',
      ]);
    });

    it('should report each subscription plan, status, period end and cancel flag', async () => {
      const endsAt = new Date(Date.now() + 86400000 * 12);
      entitlement = [
        subscriptionTo('sub-pack', 'pack', {
          status: SubscriptionStatus.TRIALING,
          currentPeriodEnd: endsAt,
          cancelAtPeriodEnd: true,
        }),
      ];

      const [reported] = (
        await service.getLoginPermissionsContext(user, 'comp-1')
      ).subscriptions;

      expect(reported).toMatchObject({
        planId: 'pack',
        planName: 'Plan pack',
        status: SubscriptionStatus.TRIALING,
        endDate: endsAt,
        cancelAtPeriodEnd: true,
      });
    });

    it('should report the credits of each subscription on its own entry', async () => {
      entitlement = [
        subscriptionTo('sub-pack-a', 'pack-a', {
          creditsTotal: 10,
          creditsUsed: 4,
        }),
        subscriptionTo('sub-pack-b', 'pack-b', {
          creditsTotal: 5,
          creditsUsed: 5,
        }),
      ];

      const context = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(
        context.subscriptions.map(s => [s.remainingCredits, s.creditsTotal])
      ).toEqual([
        [6, 10],
        [0, 5],
      ]);
    });

    it('should report null credits for an unlimited subscription', async () => {
      entitlement = [subscriptionTo('sub-premium', 'premium')];

      const [reported] = (
        await service.getLoginPermissionsContext(user, 'comp-1')
      ).subscriptions;

      expect(reported).toMatchObject({
        remainingCredits: null,
        creditsTotal: null,
      });
    });

    it('should be empty when the Entitlement is empty', async () => {
      const context = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(context.subscriptions).toEqual([]);
    });
  });

  describe('the deprecated scalars', () => {
    it('should report the values of the only subscription a member holds', async () => {
      const only = subscriptionTo('sub-pack', 'pack', {
        creditsTotal: 10,
        creditsUsed: 3,
      });
      entitlement = [only];

      const context = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(context).toMatchObject({
        hasActiveSubscription: true,
        subscriptionId: 'sub-pack',
        endDate: only.currentPeriodEnd,
        remainingCredits: 7,
        creditsTotal: 10,
      });
      expect(context.plan?.name).toBe('Plan pack');
    });

    it('should resolve to the unlimited subscription over a longer Session Pack', async () => {
      entitlement = [
        subscriptionTo('sub-pack', 'pack', {
          creditsTotal: 10,
          currentPeriodEnd: new Date(Date.now() + 86400000 * 400),
        }),
        subscriptionTo('sub-premium', 'premium'),
      ];

      const context = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(context.subscriptionId).toBe('sub-premium');
      expect(context.remainingCredits).toBeNull();
    });

    it('should not change what it reports when a Session Pack joins an unlimited subscription', async () => {
      const premium = subscriptionTo('sub-premium', 'premium');
      entitlement = [premium];
      const before = await service.getLoginPermissionsContext(user, 'comp-1');

      entitlement = [
        premium,
        subscriptionTo('sub-pack', 'pack', { creditsTotal: 10 }),
      ];
      const after = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(after.subscriptionId).toBe(before.subscriptionId);
      expect(after.remainingCredits).toBe(before.remainingCredits);
      expect(after.creditsTotal).toBe(before.creditsTotal);
    });

    it('should fall back to the furthest period end when none is unlimited', async () => {
      entitlement = [
        subscriptionTo('sub-near', 'pack-a', {
          creditsTotal: 10,
          currentPeriodEnd: new Date(Date.now() + 86400000 * 5),
        }),
        subscriptionTo('sub-far', 'pack-b', {
          creditsTotal: 3,
          currentPeriodEnd: new Date(Date.now() + 86400000 * 50),
        }),
      ];

      const context = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(context.subscriptionId).toBe('sub-far');
      expect(context.creditsTotal).toBe(3);
    });
  });
});
