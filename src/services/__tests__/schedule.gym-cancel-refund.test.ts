import moment from 'moment';

import { Company } from '../../entities/Company';
import { Schedule } from '../../entities/Schedule';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { ScheduleState, UserRoleEnum } from '../../types/enums';
import { ScheduleService } from '../schedule.service';

jest.mock('../notification.service', () => ({
  NotificationService: jest.fn().mockImplementation(() => ({
    sendToUsers: jest.fn(async () => {}),
    sendToUser: jest.fn(async () => {}),
  })),
}));

/**
 * Tests del seam ScheduleService para el reembolso por cancelación del gym —
 * issue #111.
 *
 * Cuando el gym cancela un Schedule (changeScheduleStatus → CANCELLED,
 * removeSchedule con inscritos, cutOffSchedules) cada inscrito con pack
 * recupera 1 crédito, incluso si la clase ya pasó. Prior art:
 * schedule.session-credit.test.ts.
 */

function createMockCollection<T>(initialItems: T[] = []): any {
  let items = [...initialItems];
  const coll = {
    getItems: jest.fn(() => items),
    contains: jest.fn((item: any) => items.some((i: any) => i.id === item.id)),
    add: jest.fn((...newItems: any[]) => {
      for (const ni of newItems) {
        if (!items.some((i: any) => i.id === ni.id)) {
          items.push(ni);
        }
      }
    }),
    remove: jest.fn((...removedItems: any[]) => {
      items = items.filter(
        (i: any) => !removedItems.some((r: any) => r.id === i.id)
      );
    }),
    isInitialized: jest.fn(() => true),
    init: jest.fn(async () => {}),
  };
  Object.defineProperty(coll, 'length', {
    get: () => items.length,
    configurable: true,
  });
  return coll;
}

describe('ScheduleService — gym cancellation refunds session credits', () => {
  let service: ScheduleService;
  let mockEm: any;
  let mockScheduleRepo: any;
  let subscriptionsByUser: Record<string, any>;

  const admin = {
    id: 'admin-1',
    contextRole: UserRoleEnum.ADMIN,
    activeCompanyId: 'comp-1',
  };

  function buildUser(id: string): User {
    const user = new User({} as any);
    user.id = id;
    user.schedules = createMockCollection([]);
    user.waitListSchedules = createMockCollection([]);
    return user;
  }

  function buildSubscription(overrides: Record<string, any> = {}): any {
    return {
      id: `sub-${overrides.user ?? 'x'}`,
      company: { id: 'comp-1' },
      status: SubscriptionStatus.ACTIVE,
      creditsTotal: 4,
      creditsUsed: 2,
      metadata: { history: [] },
      ...overrides,
    };
  }

  function buildSchedule(overrides: Record<string, any> = {}): Schedule {
    const schedule = new Schedule({
      startDate: moment().add(1, 'day').valueOf(),
      maxUsers: 5,
      admin: { id: 'admin-1' } as any,
      ...overrides,
    } as any);
    schedule.id = 'sch-1';
    schedule.title = 'Crossfit';
    schedule.state = ScheduleState.AVAILABLE;
    schedule.company = { id: 'comp-1' } as any;
    schedule.users = createMockCollection([]);
    schedule.waitListUsers = createMockCollection([]);
    return schedule;
  }

  function subscriptionQueries(): any[] {
    return mockEm.findOne.mock.calls.filter((c: any[]) => c[0] === Subscription);
  }

  beforeEach(() => {
    subscriptionsByUser = {};
    mockScheduleRepo = { findOne: jest.fn(), find: jest.fn() };

    mockEm = {
      getRepository: jest.fn(() => mockScheduleRepo),
      findOne: jest.fn(async (entity: any, where: any) => {
        if (entity === Subscription) return subscriptionsByUser[where.user] ?? null;
        if (entity === Company) return { scheduleOptions: null };
        return null;
      }),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(async () => {}),
      execute: jest.fn(async (_sql: string, params: any[]) => {
        const sub = Object.values(subscriptionsByUser).find(
          (s: any) => s?.id === params[0]
        ) as any;
        if (!sub || sub.creditsUsed <= 0) {
          return { affectedRows: 0, row: undefined };
        }
        return { affectedRows: 1, row: { credits_used: sub.creditsUsed - 1 } };
      }),
      transactional: jest.fn(async (cb: any) => cb(mockEm)),
    };

    service = new ScheduleService(mockEm as any);
  });

  // ─────────────────────────────────────────────
  // changeScheduleStatus → CANCELLED
  // ─────────────────────────────────────────────
  describe('changeScheduleStatus → CANCELLED', () => {
    it('refunds 1 credit to every enrolled member with a pack', async () => {
      const u1 = buildUser('user-1');
      const u2 = buildUser('user-2');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      subscriptionsByUser['user-2'] = buildSubscription({ user: 'user-2', creditsUsed: 1 });
      const schedule = buildSchedule();
      schedule.users = createMockCollection([u1, u2]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.CANCELLED,
        'Coach enfermo'
      );

      expect(res.success).toBe(true);
      expect(schedule.state).toBe(ScheduleState.CANCELLED);
      expect(mockEm.execute).toHaveBeenCalledTimes(2);
      const [sql, params, method] = mockEm.execute.mock.calls[0];
      expect(sql).toMatch(/update\s+"subscription"/i);
      expect(sql).toMatch(/credits_used\s*>\s*0/i);
      expect(sql).toMatch(/company_id\s*=\s*\?/i);
      expect(params).toEqual(['sub-user-1', 'comp-1']);
      expect(method).toBe('run');

      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(1);
      expect(subscriptionsByUser['user-2'].creditsUsed).toBe(0);
      for (const id of ['user-1', 'user-2']) {
        expect(subscriptionsByUser[id].metadata.history).toHaveLength(1);
        expect(subscriptionsByUser[id].metadata.history[0]).toMatchObject({
          event: 'credit_refunded',
          actor: 'admin-1',
          scheduleId: 'sch-1',
        });
        expect(mockEm.persist).toHaveBeenCalledWith(subscriptionsByUser[id]);
      }
      expect(mockEm.flush).toHaveBeenCalled();
    });

    it('refunds even if startDate has already passed (coach no-show)', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      const schedule = buildSchedule({
        startDate: moment().subtract(2, 'hours').valueOf(),
      });
      schedule.users = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.CANCELLED
      );

      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(1);
      expect(subscriptionsByUser['user-1'].metadata.history[0]).toMatchObject({
        event: 'credit_refunded',
        scheduleId: 'sch-1',
      });
    });

    it('looks up the live subscription of each member in the schedule company (ACTIVE/TRIALING, period in course)', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      const schedule = buildSchedule();
      schedule.users = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.CANCELLED
      );

      const [, where, options] = subscriptionQueries()[0];
      expect(where.user).toBe('user-1');
      expect(where.company).toBe('comp-1');
      expect(where.status.$in).toEqual(
        expect.arrayContaining([
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIALING,
        ])
      );
      expect(where.currentPeriodStart).toBeDefined();
      expect(where.currentPeriodEnd).toBeDefined();
      expect(options).toEqual({ filters: false });
    });

    it('does not refund a member without a live subscription (closed pack)', async () => {
      const u1 = buildUser('user-1');
      const u2 = buildUser('user-2');
      subscriptionsByUser['user-2'] = buildSubscription({ user: 'user-2' });
      const schedule = buildSchedule();
      schedule.users = createMockCollection([u1, u2]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.CANCELLED
      );

      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      expect(mockEm.execute.mock.calls[0][1]).toEqual(['sub-user-2', 'comp-1']);
      expect(subscriptionsByUser['user-2'].creditsUsed).toBe(1);
    });

    it('never goes below 0: a 0-row conditional UPDATE leaves the entity untouched', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({
        user: 'user-1',
        creditsUsed: 0,
      });
      const schedule = buildSchedule();
      schedule.users = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.CANCELLED
      );

      expect(res.success).toBe(true);
      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(0);
      expect(subscriptionsByUser['user-1'].metadata.history).toHaveLength(0);
    });

    it('does not touch an unlimited subscription', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({
        user: 'user-1',
        creditsTotal: null,
        creditsUsed: 0,
      });
      const schedule = buildSchedule();
      schedule.users = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.CANCELLED
      );

      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(subscriptionsByUser['user-1'].metadata.history).toHaveLength(0);
    });

    it('does not refund when the schedule is already CANCELLED', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      const schedule = buildSchedule();
      schedule.state = ScheduleState.CANCELLED;
      schedule.users = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.CANCELLED
      );

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(2);
    });

    it('does not refund when re-activating (CANCELLED → AVAILABLE)', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      const schedule = buildSchedule();
      schedule.state = ScheduleState.CANCELLED;
      schedule.users = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.AVAILABLE
      );

      expect(schedule.state).toBe(ScheduleState.AVAILABLE);
      expect(mockEm.execute).not.toHaveBeenCalled();
    });

    it('does not refund waitlisted users (they never consumed a credit)', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      const schedule = buildSchedule();
      schedule.waitListUsers = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.changeScheduleStatus(
        admin as any,
        'sch-1',
        ScheduleState.CANCELLED
      );

      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(2);
    });
  });

  // ─────────────────────────────────────────────
  // removeSchedule con inscritos
  // ─────────────────────────────────────────────
  describe('removeSchedule', () => {
    it('refunds 1 credit to every enrolled member and deletes the schedule', async () => {
      const u1 = buildUser('user-1');
      const u2 = buildUser('user-2');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      subscriptionsByUser['user-2'] = buildSubscription({ user: 'user-2' });
      const schedule = buildSchedule();
      schedule.users = createMockCollection([u1, u2]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.removeSchedule(admin as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).toHaveBeenCalledTimes(2);
      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(1);
      expect(subscriptionsByUser['user-2'].creditsUsed).toBe(1);
      expect(subscriptionsByUser['user-1'].metadata.history[0]).toMatchObject({
        event: 'credit_refunded',
        actor: 'admin-1',
        scheduleId: 'sch-1',
      });
      expect(mockEm.remove).toHaveBeenCalledWith(schedule);
      expect(mockEm.flush).toHaveBeenCalled();
    });

    it('refunds even if startDate has already passed', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      const schedule = buildSchedule({
        startDate: moment().subtract(1, 'day').valueOf(),
      });
      schedule.users = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.removeSchedule(admin as any, 'sch-1');

      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(1);
      expect(mockEm.remove).toHaveBeenCalledWith(schedule);
    });

    it('does not refund a closed pack, never goes below 0, and ignores waitlist', async () => {
      const closed = buildUser('user-closed');
      const zero = buildUser('user-zero');
      const waiting = buildUser('user-wait');
      subscriptionsByUser['user-zero'] = buildSubscription({
        user: 'user-zero',
        creditsUsed: 0,
      });
      subscriptionsByUser['user-wait'] = buildSubscription({ user: 'user-wait' });
      const schedule = buildSchedule();
      schedule.users = createMockCollection([closed, zero]);
      schedule.waitListUsers = createMockCollection([waiting]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.removeSchedule(admin as any, 'sch-1');

      expect(res.success).toBe(true);
      // Solo se intenta el UPDATE para quien tiene suscripción viva e inscrita
      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      expect(mockEm.execute.mock.calls[0][1]).toEqual(['sub-user-zero', 'comp-1']);
      expect(subscriptionsByUser['user-zero'].creditsUsed).toBe(0);
      expect(subscriptionsByUser['user-zero'].metadata.history).toHaveLength(0);
      expect(subscriptionsByUser['user-wait'].creditsUsed).toBe(2);
      expect(mockEm.remove).toHaveBeenCalledWith(schedule);
    });

    it('does not refund twice: deleting an already-CANCELLED schedule refunds nothing', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      const schedule = buildSchedule();
      schedule.state = ScheduleState.CANCELLED;
      schedule.users = createMockCollection([u1]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.removeSchedule(admin as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(2);
      expect(mockEm.remove).toHaveBeenCalledWith(schedule);
    });

    it('still deletes a schedule without users (no credit query at all)', async () => {
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.removeSchedule(admin as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(subscriptionQueries()).toHaveLength(0);
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(mockEm.remove).toHaveBeenCalledWith(schedule);
    });
  });

  // ─────────────────────────────────────────────
  // cutOffSchedules
  // ─────────────────────────────────────────────
  describe('cutOffSchedules', () => {
    function cutOffCandidate(users: User[]): Schedule {
      const schedule = buildSchedule({
        startDate: moment().add(30, 'minutes').valueOf(),
      });
      schedule.company = {
        id: 'comp-1',
        scheduleOptions: { bookingCutoffMinutes: 60, minBookingsRequired: 3 },
      } as any;
      schedule.users = createMockCollection(users);
      return schedule;
    }

    it('refunds 1 credit to every enrolled member of each cut-off schedule, as system', async () => {
      const u1 = buildUser('user-1');
      const u2 = buildUser('user-2');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      subscriptionsByUser['user-2'] = buildSubscription({ user: 'user-2' });
      const schedule = cutOffCandidate([u1, u2]);
      mockScheduleRepo.find.mockResolvedValue([schedule]);

      const cancelled = await service.cutOffSchedules();

      expect(cancelled).toBe(1);
      expect(schedule.state).toBe(ScheduleState.CANCELLED);
      expect(mockEm.execute).toHaveBeenCalledTimes(2);
      expect(subscriptionsByUser['user-1'].creditsUsed).toBe(1);
      expect(subscriptionsByUser['user-2'].creditsUsed).toBe(1);
      expect(subscriptionsByUser['user-1'].metadata.history[0]).toMatchObject({
        event: 'credit_refunded',
        actor: 'system',
        scheduleId: 'sch-1',
      });
      expect(mockEm.flush).toHaveBeenCalled();
    });

    it('scopes the subscription lookup to the schedule company (no request context in CRON)', async () => {
      const u1 = buildUser('user-1');
      subscriptionsByUser['user-1'] = buildSubscription({ user: 'user-1' });
      mockScheduleRepo.find.mockResolvedValue([cutOffCandidate([u1])]);

      await service.cutOffSchedules();

      const [, where, options] = subscriptionQueries()[0];
      expect(where.company).toBe('comp-1');
      expect(options).toEqual({ filters: false });
    });

    it('does not refund a closed pack and never goes below 0', async () => {
      const closed = buildUser('user-closed');
      const zero = buildUser('user-zero');
      subscriptionsByUser['user-zero'] = buildSubscription({
        user: 'user-zero',
        creditsUsed: 0,
      });
      mockScheduleRepo.find.mockResolvedValue([cutOffCandidate([closed, zero])]);

      const cancelled = await service.cutOffSchedules();

      expect(cancelled).toBe(1);
      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      expect(subscriptionsByUser['user-zero'].creditsUsed).toBe(0);
      expect(subscriptionsByUser['user-zero'].metadata.history).toHaveLength(0);
    });

    it('does not refund schedules that are not cut off', async () => {
      const users = [buildUser('user-1'), buildUser('user-2'), buildUser('user-3')];
      for (const u of users) {
        subscriptionsByUser[u.id] = buildSubscription({ user: u.id });
      }
      const schedule = cutOffCandidate(users); // 3 >= minBookingsRequired
      mockScheduleRepo.find.mockResolvedValue([schedule]);

      const cancelled = await service.cutOffSchedules();

      expect(cancelled).toBe(0);
      expect(schedule.state).toBe(ScheduleState.AVAILABLE);
      expect(mockEm.execute).not.toHaveBeenCalled();
    });
  });
});
