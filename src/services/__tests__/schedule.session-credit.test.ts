import moment from 'moment';

import { Company } from '../../entities/Company';
import { Schedule } from '../../entities/Schedule';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { ScheduleState, UserRoleEnum } from '../../types/enums';
import { ValidationError, VAL_ERRORS } from '../../utils/errors.util';
import { ScheduleService } from '../schedule.service';

/**
 * Tests del seam ScheduleService para Session Credits — issue #109.
 *
 * Consumo de 1 crédito al reservar (UPDATE condicional atómico) y reembolso al
 * desapuntarse antes de que empiece la clase. Prior art:
 * schedule.service.test.ts (EM mockeado, colecciones simuladas).
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

describe('ScheduleService — Session Credits', () => {
  let service: ScheduleService;
  let mockEm: any;
  let mockScheduleRepo: any;
  let scheduleOptions: any;
  let user: User;
  let subscription: any;

  const member = {
    id: 'user-1',
    contextRole: UserRoleEnum.STANDARD,
    activeCompanyId: 'comp-1',
  };

  function buildSchedule(overrides: Record<string, any> = {}): Schedule {
    const schedule = new Schedule({
      startDate: moment().add(1, 'day').valueOf(),
      maxUsers: 5,
      admin: { id: 'admin-1' } as any,
      ...overrides,
    } as any);
    schedule.id = 'sch-1';
    schedule.state = ScheduleState.AVAILABLE;
    schedule.users = createMockCollection([]);
    schedule.waitListUsers = createMockCollection([]);
    return schedule;
  }

  function buildSubscription(overrides: Record<string, any> = {}): any {
    return {
      id: 'sub-1',
      company: { id: 'comp-1' },
      status: SubscriptionStatus.ACTIVE,
      creditsTotal: 4,
      creditsUsed: 0,
      metadata: { history: [] },
      ...overrides,
    };
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    user.schedules = createMockCollection([]);
    user.waitListSchedules = createMockCollection([]);

    subscription = buildSubscription();

    scheduleOptions = {
      id: 'opt-1',
      maxActiveReservations: 2,
      sameDayBookingAllowed: true,
      maxAdvanceBookingDays: 7,
    };

    mockScheduleRepo = { findOne: jest.fn() };

    mockEm = {
      getRepository: jest.fn(() => mockScheduleRepo),
      findOne: jest.fn(async (entity: any) => {
        if (entity === User) return user;
        if (entity === Company) return { scheduleOptions };
        if (entity === Subscription) return subscription;
        return null;
      }),
      persist: jest.fn(),
      flush: jest.fn(async () => {}),
      execute: jest.fn(),
      transactional: jest.fn(async (cb: any) => cb(mockEm)),
    };

    service = new ScheduleService(mockEm as any);
  });

  // ─────────────────────────────────────────────
  // addUserToSchedule — consumo
  // ─────────────────────────────────────────────
  describe('addUserToSchedule', () => {
    it('consumes 1 credit with an atomic conditional UPDATE scoped by company_id', async () => {
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 1 },
      });

      const res = await service.addUserToSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      const [sql, params, method] = mockEm.execute.mock.calls[0];
      expect(sql).toMatch(/update\s+"subscription"/i);
      expect(sql).toMatch(/credits_used\s*<\s*credits_total/i);
      expect(sql).toMatch(/company_id\s*=\s*\?/i);
      expect(params).toEqual(['sub-1', 'comp-1']);
      expect(method).toBe('run');

      expect(subscription.creditsUsed).toBe(1);
      expect(schedule.users.getItems().map((u: any) => u.id)).toEqual([
        'user-1',
      ]);
      expect(mockEm.persist).toHaveBeenCalledWith(subscription);
    });

    it('records credit_consumed in the subscription history with the scheduleId', async () => {
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 1 },
      });

      await service.addUserToSchedule(member as any, 'sch-1');

      const history = subscription.metadata.history;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        event: 'credit_consumed',
        actor: 'user-1',
        scheduleId: 'sch-1',
      });
      expect(typeof history[0].timestamp).toBe('string');
    });

    it('rejects with NO_SESSION_CREDITS when the conditional UPDATE affects 0 rows', async () => {
      subscription = buildSubscription({ creditsUsed: 4 });
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({ affectedRows: 0, row: undefined });

      await expect(
        service.addUserToSchedule(member as any, 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.NO_SESSION_CREDITS);

      expect(schedule.users.getItems()).toHaveLength(0);
      expect(user.schedules.getItems()).toHaveLength(0);
      expect(subscription.creditsUsed).toBe(4);
      expect(subscription.metadata.history).toHaveLength(0);
    });

    it('is a ValidationError so the resolver maps it to the validation catalog', async () => {
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({ affectedRows: 0 });

      await expect(
        service.addUserToSchedule(member as any, 'sch-1')
      ).rejects.toThrow(ValidationError);
    });

    it('applies the same consumption and rejection when an admin books', async () => {
      const admin = { ...member, contextRole: UserRoleEnum.ADMIN };
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({ affectedRows: 0 });

      await expect(
        service.addUserToSchedule(admin as any, 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.NO_SESSION_CREDITS);
      expect(mockEm.execute).toHaveBeenCalledTimes(1);
    });

    it('applies the same consumption when the coach of the event books', async () => {
      const coach = {
        ...member,
        id: 'admin-1',
        contextRole: UserRoleEnum.COACH,
      };
      user.id = 'admin-1';
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 1 },
      });

      const res = await service.addUserToSchedule(coach as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      expect(subscription.creditsUsed).toBe(1);
    });

    it('does nothing for an unlimited subscription (creditsTotal null)', async () => {
      subscription = buildSubscription({ creditsTotal: null });
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.addUserToSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(subscription.creditsUsed).toBe(0);
      expect(subscription.metadata.history).toHaveLength(0);
    });

    it('does nothing when the member has no active subscription in the company', async () => {
      subscription = null;
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.addUserToSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
    });

    it('looks up only the live subscription of the member in the active company', async () => {
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 1 },
      });

      await service.addUserToSchedule(member as any, 'sch-1');

      const call = mockEm.findOne.mock.calls.find(
        (c: any[]) => c[0] === Subscription
      );
      expect(call).toBeDefined();
      const [, where, options] = call!;
      expect(where.user).toBe('user-1');
      expect(where.company).toBe('comp-1');
      expect(where.status.$in).toEqual(
        expect.arrayContaining([
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIALING,
        ])
      );
      expect(where.currentPeriodEnd.$gte).toBeInstanceOf(Date);
      expect(options.filters).toBe(false);
    });

    it('keeps enforcing maxActiveReservations before touching credits', async () => {
      user.schedules = createMockCollection([
        { id: 'old-1', state: ScheduleState.AVAILABLE },
        { id: 'old-2', state: ScheduleState.AVAILABLE },
      ]);
      const schedule = buildSchedule();
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await expect(
        service.addUserToSchedule(member as any, 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.MAX_ACTIVE_RESERVATIONS_REACHED);
      expect(mockEm.execute).not.toHaveBeenCalled();
    });

    it('does not consume a credit when the member lands on the waitlist', async () => {
      const schedule = buildSchedule({ maxUsers: 1 });
      schedule.users = createMockCollection([{ id: 'other' }]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.addUserToSchedule(member as any, 'sch-1');

      expect(res.message).toBe('User added to waitlist');
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(subscription.creditsUsed).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // removeUserFromSchedule — reembolso
  // ─────────────────────────────────────────────
  describe('removeUserFromSchedule', () => {
    function bookedSchedule(startDate: number): Schedule {
      const schedule = buildSchedule({ startDate });
      schedule.users = createMockCollection([user]);
      return schedule;
    }

    it('refunds 1 credit when the member unregisters before startDate', async () => {
      subscription = buildSubscription({ creditsUsed: 2 });
      const schedule = bookedSchedule(moment().add(1, 'day').valueOf());
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 1 },
      });

      const res = await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      const [sql, params, method] = mockEm.execute.mock.calls[0];
      expect(sql).toMatch(/update\s+"subscription"/i);
      expect(sql).toMatch(/credits_used\s*>\s*0/i);
      expect(sql).toMatch(/company_id\s*=\s*\?/i);
      expect(params).toEqual(['sub-1', 'comp-1']);
      expect(method).toBe('run');

      expect(subscription.creditsUsed).toBe(1);
      expect(subscription.metadata.history).toHaveLength(1);
      expect(subscription.metadata.history[0]).toMatchObject({
        event: 'credit_refunded',
        actor: 'user-1',
        scheduleId: 'sch-1',
      });
      expect(mockEm.persist).toHaveBeenCalledWith(subscription);
    });

    it('does not refund when startDate has already passed', async () => {
      subscription = buildSubscription({ creditsUsed: 2 });
      const schedule = bookedSchedule(moment().subtract(1, 'hour').valueOf());
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(subscription.creditsUsed).toBe(2);
      expect(subscription.metadata.history).toHaveLength(0);
    });

    it('never goes below 0: a 0-row conditional UPDATE leaves the entity untouched', async () => {
      subscription = buildSubscription({ creditsUsed: 0 });
      const schedule = bookedSchedule(moment().add(1, 'day').valueOf());
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({ affectedRows: 0, row: undefined });

      const res = await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(subscription.creditsUsed).toBe(0);
      expect(subscription.metadata.history).toHaveLength(0);
    });

    it('does not refund when the member has no live subscription (closed pack)', async () => {
      subscription = null;
      const schedule = bookedSchedule(moment().add(1, 'day').valueOf());
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
    });

    it('does not refund an unlimited subscription', async () => {
      subscription = buildSubscription({ creditsTotal: null });
      const schedule = bookedSchedule(moment().add(1, 'day').valueOf());
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(mockEm.execute).not.toHaveBeenCalled();
    });

    it('does not refund when leaving the waitlist', async () => {
      subscription = buildSubscription({ creditsUsed: 2 });
      const schedule = buildSchedule();
      schedule.waitListUsers = createMockCollection([user]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const res = await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(res.message).toBe('User removed from waitlist');
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(subscription.creditsUsed).toBe(2);
    });

    it('refunds the removed member (not the admin) when an admin unregisters them', async () => {
      const admin = {
        id: 'user-admin',
        contextRole: UserRoleEnum.ADMIN,
        activeCompanyId: 'comp-1',
      };
      subscription = buildSubscription({ creditsUsed: 1 });
      const schedule = bookedSchedule(moment().add(1, 'day').valueOf());
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 0 },
      });

      await service.removeUserFromSchedule(admin as any, 'sch-1', 'user-1');

      const call = mockEm.findOne.mock.calls.find(
        (c: any[]) => c[0] === Subscription
      );
      expect(call![1].user).toBe('user-1');
      expect(subscription.creditsUsed).toBe(0);
      expect(subscription.metadata.history[0]).toMatchObject({
        event: 'credit_refunded',
        actor: 'user-admin',
        scheduleId: 'sch-1',
      });
    });
  });
});
