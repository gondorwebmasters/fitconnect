import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { SubscriptionService } from '../subscription.service';

/**
 * Tests de `getActiveSubscription` — issue #20.
 *
 * La query ya devolvía un `subscriptions` plural, pero con dos defectos: filtraba
 * solo por estado, así que colaba **Suscripciones Futuras** cuyo periodo aún no ha
 * empezado, y su campo singular era el primero por `currentPeriodStart` en vez de
 * la resolución determinista de los escalares del payload.
 *
 * El `where` del mock se evalúa de verdad contra las fixtures, de modo que la
 * exclusión de la Suscripción Futura la decide el predicado y no un stub.
 */
describe('SubscriptionService.getActiveSubscription', () => {
  let service: SubscriptionService;
  let mockEm: any;
  let subscriptions: any[];

  const DAY = 86400000;

  function subscriptionTo(
    id: string,
    overrides: Record<string, any> = {}
  ): any {
    const sub = new Subscription();
    Object.assign(sub, {
      id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + DAY * 30),
      trialEnd: null,
      creditsTotal: null,
      creditsUsed: 0,
      plan: { id: `plan-${id}`, name: `Plan ${id}` },
      ...overrides,
    });
    return sub;
  }

  /** Aplica los predicados reales de la consulta a las fixtures. */
  function matching(where: any): any[] {
    return subscriptions.filter(sub => {
      if (where.status?.$in && !where.status.$in.includes(sub.status)) {
        return false;
      }
      if (
        where.currentPeriodStart?.$lte !== undefined &&
        !(sub.currentPeriodStart <= where.currentPeriodStart.$lte)
      ) {
        return false;
      }
      if (
        where.currentPeriodEnd?.$gte !== undefined &&
        !(sub.currentPeriodEnd >= where.currentPeriodEnd.$gte)
      ) {
        return false;
      }
      return true;
    });
  }

  beforeEach(() => {
    subscriptions = [];

    mockEm = {
      findOne: jest.fn(async (entity: any) => {
        if (entity === User) return { id: 'user-1' };
        return null;
      }),
      find: jest.fn(async (entity: any, where: any) =>
        entity === Subscription ? matching(where) : []
      ),
    };

    service = new SubscriptionService(mockEm as any, {} as any);
  });

  it('should return the live subscriptions of the member', async () => {
    subscriptions = [subscriptionTo('sub-1')];

    const response = await service.getActiveSubscription('user-1');

    expect((response as any).subscriptions.map((s: any) => s.id)).toEqual([
      'sub-1',
    ]);
  });

  it('should exclude a Future Subscription whose period has not started', async () => {
    const live = subscriptionTo('sub-live');
    subscriptions = [
      live,
      subscriptionTo('sub-future', {
        currentPeriodStart: new Date(Date.now() + DAY * 40),
        currentPeriodEnd: new Date(Date.now() + DAY * 70),
      }),
    ];

    const response = await service.getActiveSubscription('user-1');

    expect((response as any).subscriptions).toEqual([live]);
    expect((response as any).subscription).toBe(live);
  });

  it('should exclude a subscription whose period has already ended', async () => {
    subscriptions = [
      subscriptionTo('sub-past', {
        currentPeriodStart: new Date(Date.now() - DAY * 70),
        currentPeriodEnd: new Date(Date.now() - DAY * 40),
      }),
    ];

    const response = await service.getActiveSubscription('user-1');

    expect((response as any).subscriptions).toEqual([]);
    expect((response as any).subscription).toBeNull();
  });

  it('should exclude a subscription that is neither ACTIVE nor TRIALING', async () => {
    subscriptions = [
      subscriptionTo('sub-past-due', { status: SubscriptionStatus.PAST_DUE }),
    ];

    const response = await service.getActiveSubscription('user-1');

    expect((response as any).subscriptions).toEqual([]);
  });

  it('should resolve the singular field to the unlimited subscription, not the first by period start', async () => {
    const unlimited = subscriptionTo('sub-premium', {
      currentPeriodStart: new Date(Date.now() - DAY),
    });
    const pack = subscriptionTo('sub-pack', {
      currentPeriodStart: new Date(Date.now() - DAY * 10),
      currentPeriodEnd: new Date(Date.now() + DAY * 400),
      creditsTotal: 10,
    });
    subscriptions = [pack, unlimited];

    const response = await service.getActiveSubscription('user-1');

    expect((response as any).subscription).toBe(unlimited);
  });

  it('should resolve the singular field to the furthest period end when none is unlimited', async () => {
    const near = subscriptionTo('sub-near', { creditsTotal: 10 });
    const far = subscriptionTo('sub-far', {
      creditsTotal: 3,
      currentPeriodEnd: new Date(Date.now() + DAY * 90),
    });
    subscriptions = [near, far];

    const response = await service.getActiveSubscription('user-1');

    expect((response as any).subscription).toBe(far);
  });

  it('should report null when the member holds nothing live', async () => {
    const response = await service.getActiveSubscription('user-1');

    expect(response as any).toMatchObject({
      subscription: null,
      subscriptions: [],
    });
  });
});
