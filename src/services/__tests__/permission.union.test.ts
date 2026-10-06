import { Permission } from '../../entities/Permission';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { UserRole } from '../../entities/UserRole';
import { UserRoleEnum } from '../../types/enums';
import { PermissionService } from '../permission.service';

/**
 * Tests de la unión de permisos del Entitlement — issue #19 (ADR 0006,
 * decisión 3): los permisos de un miembro son la **unión** de los de los planes
 * de sus suscripciones vigentes. Un plan nunca *quita* lo que otro concede.
 *
 * No hay intersección, ni precedencia, ni permisos negativos: es una decisión
 * del ADR, no una simplificación pendiente de completar.
 */
describe('PermissionService — the union of the Entitlement permissions', () => {
  let service: PermissionService;
  let mockEm: any;
  let entitlement: any[];
  let userRole: UserRole | null;
  let user: User;

  /** Un plan que concede exactamente estos permisos. */
  function planGranting(id: string, grants: string[]) {
    return {
      id,
      name: `Plan ${id}`,
      amount: 0,
      currency: 'eur',
      interval: 'month',
      planPermissions: {
        init: jest.fn(async () => {}),
        getItems: () =>
          grants.map(name => ({
            isActive: true,
            permission: { id: `perm-${name}`, name, isActive: true },
          })),
      },
    };
  }

  function subscriptionTo(id: string, plan: any, overrides = {}) {
    const sub = new Subscription();
    Object.assign(sub, {
      id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date(Date.now() - 86400000),
      currentPeriodEnd: new Date(Date.now() + 86400000 * 20),
      creditsTotal: null,
      creditsUsed: 0,
      cancelAtPeriodEnd: false,
      plan,
      ...overrides,
    });
    return sub;
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    user.isSuperAdmin = false;

    entitlement = [];
    userRole = null;

    mockEm = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === UserRole) return userRole;
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

  describe('getUserPermissionsInCompany', () => {
    it('should unite the permissions of every live plan', async () => {
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
        subscriptionTo('sub-2', planGranting('pack', ['workouts:read'])),
      ];

      const permissions = await service.getUserPermissionsInCompany(
        'user-1',
        'comp-1'
      );

      expect(permissions.map(p => p.name).sort()).toEqual([
        'schedules:read',
        'workouts:read',
      ]);
    });

    it('should keep a permission when another plan in the set does not grant it', async () => {
      const generous = planGranting('premium', [
        'schedules:read',
        'workouts:read',
      ]);
      const meagre = planGranting('pack', ['schedules:read']);
      entitlement = [
        subscriptionTo('sub-1', generous),
        subscriptionTo('sub-2', meagre),
      ];

      const permissions = await service.getUserPermissionsInCompany(
        'user-1',
        'comp-1'
      );

      expect(permissions.map(p => p.name)).toContain('workouts:read');
    });

    it('should report a permission only once when two plans grant it', async () => {
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
        subscriptionTo('sub-2', planGranting('pack', ['schedules:read'])),
      ];

      const permissions = await service.getUserPermissionsInCompany(
        'user-1',
        'comp-1'
      );

      expect(permissions.map(p => p.name)).toEqual(['schedules:read']);
    });

    it('should give the permissions of the single plan when the member holds one subscription', async () => {
      entitlement = [
        subscriptionTo(
          'sub-1',
          planGranting('premium', ['schedules:read', 'workouts:read'])
        ),
      ];

      const permissions = await service.getUserPermissionsInCompany(
        'user-1',
        'comp-1'
      );

      expect(permissions.map(p => p.name)).toEqual([
        'schedules:read',
        'workouts:read',
      ]);
    });

    it('should ignore a plan permission when it is inactive on either side', async () => {
      const plan = planGranting('premium', ['schedules:read']);
      plan.planPermissions.getItems = () => [
        {
          isActive: false,
          permission: { id: 'p1', name: 'chats:manage', isActive: true },
        },
        {
          isActive: true,
          permission: { id: 'p2', name: 'polls:manage', isActive: false },
        },
        {
          isActive: true,
          permission: { id: 'p3', name: 'schedules:read', isActive: true },
        },
      ];
      entitlement = [subscriptionTo('sub-1', plan)];

      const permissions = await service.getUserPermissionsInCompany(
        'user-1',
        'comp-1'
      );

      expect(permissions.map(p => p.name)).toEqual(['schedules:read']);
    });

    it('should return nothing when the Entitlement is empty', async () => {
      entitlement = [];

      const permissions = await service.getUserPermissionsInCompany(
        'user-1',
        'comp-1'
      );

      expect(permissions).toEqual([]);
    });
  });

  describe('userHasPermissionInCompany', () => {
    it('should grant a permission when only the second plan carries it', async () => {
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
        subscriptionTo('sub-2', planGranting('pack', ['workouts:read'])),
      ];

      await expect(
        service.userHasPermissionInCompany('user-1', 'workouts:read', 'comp-1')
      ).resolves.toBe(true);
    });

    it('should resolve a module-level grant when it comes from another plan in the set', async () => {
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
        subscriptionTo('sub-2', planGranting('pack', ['workouts:manage'])),
      ];

      await expect(
        service.userHasPermissionInCompany('user-1', 'workouts:create', 'comp-1')
      ).resolves.toBe(true);
    });

    it('should resolve the wildcard when it comes from another plan in the set', async () => {
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
        subscriptionTo('sub-2', planGranting('legacy', ['*:*'])),
      ];

      await expect(
        service.userHasPermissionInCompany('user-1', 'anything:read', 'comp-1')
      ).resolves.toBe(true);
    });

    it('should refuse a permission when no plan in the Entitlement grants it', async () => {
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
        subscriptionTo('sub-2', planGranting('pack', ['workouts:read'])),
      ];

      await expect(
        service.userHasPermissionInCompany('user-1', 'payments:manage', 'comp-1')
      ).resolves.toBe(false);
    });

    it('should refuse every permission when the Entitlement is empty', async () => {
      entitlement = [];

      await expect(
        service.userHasPermissionInCompany('user-1', 'schedules:read', 'comp-1')
      ).resolves.toBe(false);
    });
  });

  describe('getLoginPermissionsContext', () => {
    it('should report the union in permissionNames when several plans are live', async () => {
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
        subscriptionTo('sub-2', planGranting('pack', ['workouts:read'])),
      ];

      const ctx = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(ctx.permissionNames.sort()).toEqual([
        'schedules:read',
        'workouts:read',
      ]);
      expect(ctx.permissions.map(p => p.name).sort()).toEqual([
        'schedules:read',
        'workouts:read',
      ]);
    });

    it('should leave the deprecated singular scalars on one subscription of the set', async () => {
      const sub = subscriptionTo(
        'sub-1',
        planGranting('premium', ['schedules:read']),
        { creditsTotal: 4, creditsUsed: 1 }
      );
      entitlement = [sub];

      const ctx = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(ctx.hasActiveSubscription).toBe(true);
      expect(ctx.plan?.id).toBe('premium');
      expect(ctx.subscriptionId).toBe('sub-1');
      expect(ctx.remainingCredits).toBe(3);
      expect(ctx.creditsTotal).toBe(4);
      expect(ctx.renewsAt).toEqual(sub.currentPeriodEnd);
    });

    it('should not derive a member union when the user is a coach', async () => {
      userRole = { role: UserRoleEnum.COACH } as any;
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['payments:manage'])),
      ];

      const ctx = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(ctx.permissionNames).toEqual(service.coachPermissionNames);
      expect(ctx.permissionNames).not.toContain('payments:manage');
    });

    it('should not derive a member union when the user is a super-admin', async () => {
      user.isSuperAdmin = true;
      entitlement = [
        subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
      ];

      const ctx = await service.getLoginPermissionsContext(user, 'comp-1');

      expect(ctx.permissionNames).toEqual(['*:*']);
    });
  });

  describe('getUserCompaniesWithPermissions', () => {
    it('should report one entry per company with the union of its plans', async () => {
      const company = { id: 'comp-1', name: 'Gym' };
      mockEm.find = jest.fn(async (entity: any) => {
        if (entity === Subscription) {
          return [
            Object.assign(
              subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
              { company }
            ),
            Object.assign(
              subscriptionTo('sub-2', planGranting('pack', ['workouts:read'])),
              { company }
            ),
          ];
        }
        return [];
      });

      const contexts = await service.getUserCompaniesWithPermissions('user-1');

      expect(contexts).toHaveLength(1);
      expect(contexts[0].companyId).toBe('comp-1');
      expect([...contexts[0].permissions].sort()).toEqual([
        'schedules:read',
        'workouts:read',
      ]);
    });

    it('should grant nothing in another company when a plan is held in one', async () => {
      const first = { id: 'comp-1', name: 'Gym One' };
      const second = { id: 'comp-2', name: 'Gym Two' };
      mockEm.find = jest.fn(async (entity: any) => {
        if (entity === Subscription) {
          return [
            Object.assign(
              subscriptionTo('sub-1', planGranting('premium', ['schedules:read'])),
              { company: first }
            ),
            Object.assign(
              subscriptionTo('sub-2', planGranting('other', ['workouts:read'])),
              { company: second }
            ),
          ];
        }
        return [];
      });

      const contexts = await service.getUserCompaniesWithPermissions('user-1');

      expect(contexts).toHaveLength(2);
      const byId = new Map(contexts.map(c => [c.companyId, c.permissions]));
      expect(byId.get('comp-1')).toEqual(['schedules:read']);
      expect(byId.get('comp-2')).toEqual(['workouts:read']);
    });
  });
});
