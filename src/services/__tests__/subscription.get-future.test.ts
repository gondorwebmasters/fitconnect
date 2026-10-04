import moment from 'moment';

import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { ForbiddenError } from '../../utils/errors.util';
import { SubscriptionService } from '../subscription.service';

/**
 * Tests de `getFutureSubscriptions`: las **Suscripciones Futuras** del miembro,
 * aparte del Entitlement, para que el administrador vea si una asignación movió
 * la que ya había programada y el miembro vea lo que le espera.
 *
 * El `where` del mock se evalúa de verdad contra las fixtures (prior art:
 * subscription.get-active.test.ts), de modo que qué cuenta como futura lo decide
 * el predicado y no un stub.
 */
describe('SubscriptionService.getFutureSubscriptions', () => {
  let service: SubscriptionService;
  let mockEm: any;
  let subscriptions: any[];

  const MEMBER = { id: 'user-1', isAdmin: false };

  const daysFromToday = (days: number) =>
    moment().startOf('day').add(days, 'days').toDate();

  function subscriptionTo(
    id: string,
    overrides: Record<string, any> = {}
  ): any {
    const sub = new Subscription();
    Object.assign(sub, {
      id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: daysFromToday(10),
      currentPeriodEnd: daysFromToday(40),
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
        where.currentPeriodStart?.$gte !== undefined &&
        !(sub.currentPeriodStart >= where.currentPeriodStart.$gte)
      ) {
        return false;
      }
      if (
        where.currentPeriodStart?.$lte !== undefined &&
        !(sub.currentPeriodStart <= where.currentPeriodStart.$lte)
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

  const idsOf = (response: any) => response.subscriptions.map((s: any) => s.id);

  it('should return the subscriptions whose period starts after today', async () => {
    subscriptions = [subscriptionTo('sub-future')];

    const response = await service.getFutureSubscriptions('user-1', MEMBER);

    expect(idsOf(response)).toEqual(['sub-future']);
  });

  it('should leave out the live subscriptions, which are the Entitlement', async () => {
    subscriptions = [
      subscriptionTo('sub-live', {
        currentPeriodStart: daysFromToday(-5),
        currentPeriodEnd: daysFromToday(25),
      }),
      subscriptionTo('sub-future'),
    ];

    const response = await service.getFutureSubscriptions('user-1', MEMBER);

    expect(idsOf(response)).toEqual(['sub-future']);
  });

  it('should leave out one starting later today, which already counts as started', async () => {
    subscriptions = [
      subscriptionTo('sub-today', {
        currentPeriodStart: moment().endOf('day').toDate(),
      }),
    ];

    const response = await service.getFutureSubscriptions('user-1', MEMBER);

    expect(idsOf(response)).toEqual([]);
  });

  it('should include one starting tomorrow', async () => {
    subscriptions = [
      subscriptionTo('sub-tomorrow', { currentPeriodStart: daysFromToday(1) }),
    ];

    const response = await service.getFutureSubscriptions('user-1', MEMBER);

    expect(idsOf(response)).toEqual(['sub-tomorrow']);
  });

  it('should leave out an annulled one, which is no longer ACTIVE nor TRIALING', async () => {
    subscriptions = [
      subscriptionTo('sub-annulled', { status: SubscriptionStatus.CANCELED }),
      subscriptionTo('sub-trialing', { status: SubscriptionStatus.TRIALING }),
    ];

    const response = await service.getFutureSubscriptions('user-1', MEMBER);

    expect(idsOf(response)).toEqual(['sub-trialing']);
  });

  it('should order them by start date', async () => {
    subscriptions = [
      subscriptionTo('sub-late', { currentPeriodStart: daysFromToday(60) }),
      subscriptionTo('sub-soon', { currentPeriodStart: daysFromToday(3) }),
    ];

    const response = await service.getFutureSubscriptions('user-1', MEMBER);

    expect(idsOf(response)).toEqual(['sub-soon', 'sub-late']);
  });

  it("should refuse a member asking for someone else's", async () => {
    subscriptions = [subscriptionTo('sub-future')];

    await expect(
      service.getFutureSubscriptions('user-2', MEMBER)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("should let an administrator see a member's", async () => {
    subscriptions = [subscriptionTo('sub-future')];

    const response = await service.getFutureSubscriptions('user-1', {
      id: 'admin-1',
      isAdmin: true,
    });

    expect(idsOf(response)).toEqual(['sub-future']);
  });
});
