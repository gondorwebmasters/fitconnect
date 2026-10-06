import moment from 'moment';

import { Company } from '../../entities/Company';
import { Schedule } from '../../entities/Schedule';
import { ScheduleRegistration } from '../../entities/ScheduleRegistration';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import { ScheduleState, UserRoleEnum } from '../../types/enums';
import { VAL_ERRORS } from '../../utils/errors.util';
import { ScheduleService } from '../schedule.service';

/**
 * Tests del seam ScheduleService para **quién paga la reserva** — issue #21,
 * ADR 0006 decisión 6.
 *
 * Paga la suscripción que abrió la puerta, y la reserva **recuerda cuál fue**:
 * el reembolso ya no re-deriva el Entitlement, que con más de una vigente
 * devolvía el crédito a la equivocada. Prior art: schedule.session-credit.test.ts
 * (EM mockeado, colecciones simuladas).
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

describe('ScheduleService — the subscription that opens the door pays', () => {
  let service: ScheduleService;
  let mockEm: any;
  let mockScheduleRepo: any;
  let scheduleOptions: any;
  let user: User;

  /** Entitlement del miembro: lo que devuelve la consulta plural. */
  let entitlement: any[];
  /** Suscripción anotada en la reserva ya hecha, si la hay. */
  let paidBy: any;

  const member = {
    id: 'user-1',
    contextRole: UserRoleEnum.STANDARD,
    activeCompanyId: 'comp-1',
  };

  const PREMIUM = { id: 'plan-premium' };
  const PACK = { id: 'plan-pack' };

  /** Suscripción ilimitada (plan temporal): sin snapshot de créditos. */
  function unlimited(plan = PREMIUM): any {
    return {
      id: 'sub-unlimited',
      plan,
      company: { id: 'comp-1' },
      status: SubscriptionStatus.ACTIVE,
      creditsTotal: null,
      creditsUsed: 0,
      metadata: { history: [] },
    };
  }

  /** Session Pack: créditos finitos. */
  function pack(overrides: Record<string, any> = {}): any {
    return {
      id: 'sub-pack',
      plan: PACK,
      company: { id: 'comp-1' },
      status: SubscriptionStatus.ACTIVE,
      creditsTotal: 4,
      creditsUsed: 0,
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
    schedule.state = ScheduleState.AVAILABLE;
    schedule.company = { id: 'comp-1' } as any;
    schedule.users = createMockCollection([]);
    schedule.waitListUsers = createMockCollection([]);
    schedule.allowedPlans = createMockCollection([]);
    return schedule;
  }

  /** Schedule restringido a los planes dados. */
  function restrictedTo(plans: any[], overrides = {}): Schedule {
    const schedule = buildSchedule(overrides);
    schedule.allowedPlans = createMockCollection(plans);
    return schedule;
  }

  /** La suscripción que `recordRegistrationCharge` ha dejado anotada. */
  function recordedCharge(): any {
    const call = mockEm.nativeUpdate.mock.calls.find(
      (c: any[]) => c[0] === ScheduleRegistration
    );
    return call ? { where: call[1], data: call[2] } : null;
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    user.schedules = createMockCollection([]);
    user.waitListSchedules = createMockCollection([]);

    entitlement = [];
    paidBy = null;

    scheduleOptions = {
      id: 'opt-1',
      maxActiveReservations: 5,
      sameDayBookingAllowed: true,
      maxAdvanceBookingDays: 30,
    };

    mockScheduleRepo = { findOne: jest.fn() };

    mockEm = {
      getRepository: jest.fn(() => mockScheduleRepo),
      findOne: jest.fn(async (entity: any) => {
        if (entity === User) return user;
        if (entity === Company) return { scheduleOptions };
        if (entity === ScheduleRegistration) {
          return paidBy ? { paidBySubscription: paidBy } : null;
        }
        return null;
      }),
      find: jest.fn(async (entity: any) =>
        entity === Subscription ? entitlement : []
      ),
      nativeUpdate: jest.fn(async () => 1),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(async () => {}),
      execute: jest.fn(async () => ({
        affectedRows: 1,
        row: { credits_used: 1 },
      })),
      transactional: jest.fn(async (cb: any) => cb(mockEm)),
    };

    service = new ScheduleService(mockEm as any);
  });

  // ─────────────────────────────────────────────
  // Quién paga
  // ─────────────────────────────────────────────
  describe('addUserToSchedule — choosing the payer', () => {
    it('charges the subscription that satisfies the plan restriction', async () => {
      entitlement = [unlimited(), pack()];
      mockScheduleRepo.findOne.mockResolvedValue(restrictedTo([PACK]));

      await service.addUserToSchedule(member as any, 'sch-1');

      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      expect(mockEm.execute.mock.calls[0][1]).toEqual(['sub-pack', 'comp-1']);
    });

    it('charges the unlimited one when several qualify, spending no credit', async () => {
      const both = [unlimited(PACK), pack()];
      entitlement = both;
      mockScheduleRepo.findOne.mockResolvedValue(restrictedTo([PACK]));

      await service.addUserToSchedule(member as any, 'sch-1');

      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(both[1].creditsUsed).toBe(0);
    });

    it('costs nothing on an unrestricted schedule to a member who also holds a pack', async () => {
      const held = pack();
      entitlement = [held, unlimited()];
      mockScheduleRepo.findOne.mockResolvedValue(buildSchedule());

      const res = await service.addUserToSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(held.creditsUsed).toBe(0);
    });

    it('spends no credit on a schedule restricted to the time-based plan, though the member holds a pack too', async () => {
      // La otra mitad del caso del ADR 0006: el miembro sostiene *Premium* y
      // un bono, y entra a los horarios de Premium sin gastar créditos del
      // bono — solo los de los horarios del bono.
      const held = pack();
      entitlement = [unlimited(), held];
      mockScheduleRepo.findOne.mockResolvedValue(restrictedTo([PREMIUM]));

      const res = await service.addUserToSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
      expect(held.creditsUsed).toBe(0);
    });

    it('charges the pack on an unrestricted schedule when it is all the member holds', async () => {
      entitlement = [pack()];
      mockScheduleRepo.findOne.mockResolvedValue(buildSchedule());

      await service.addUserToSchedule(member as any, 'sch-1');

      expect(mockEm.execute.mock.calls[0][1]).toEqual(['sub-pack', 'comp-1']);
    });

    it('still refuses a member whose only qualifying pack is exhausted', async () => {
      entitlement = [pack({ creditsUsed: 4 })];
      mockEm.execute.mockResolvedValue({ affectedRows: 0, row: undefined });
      mockScheduleRepo.findOne.mockResolvedValue(buildSchedule());

      await expect(
        service.addUserToSchedule(member as any, 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.NO_SESSION_CREDITS);
    });
  });

  // ─────────────────────────────────────────────
  // La reserva recuerda quién pagó
  // ─────────────────────────────────────────────
  describe('addUserToSchedule — recording the payer', () => {
    it('persists the charged subscription against the registration', async () => {
      entitlement = [pack()];
      mockScheduleRepo.findOne.mockResolvedValue(buildSchedule());

      await service.addUserToSchedule(member as any, 'sch-1');

      expect(recordedCharge()).toEqual({
        where: { user: 'user-1', schedule: 'sch-1' },
        data: { paidBySubscription: 'sub-pack' },
      });
    });

    it('records the unlimited subscription too, though it spent no credit', async () => {
      entitlement = [unlimited()];
      mockScheduleRepo.findOne.mockResolvedValue(buildSchedule());

      await service.addUserToSchedule(member as any, 'sch-1');

      expect(recordedCharge()?.data).toEqual({
        paidBySubscription: 'sub-unlimited',
      });
    });

    it('records nothing for a member without a live subscription', async () => {
      entitlement = [];
      mockScheduleRepo.findOne.mockResolvedValue(buildSchedule());

      const res = await service.addUserToSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(recordedCharge()).toBeNull();
    });

    it('records nothing when the member only lands on the waitlist', async () => {
      entitlement = [pack()];
      const full = buildSchedule({ maxUsers: 1 });
      full.users = createMockCollection([{ id: 'other' } as any]);
      mockScheduleRepo.findOne.mockResolvedValue(full);

      const res = await service.addUserToSchedule(member as any, 'sch-1');

      expect(res.message).toBe('User added to waitlist');
      expect(recordedCharge()).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // El reembolso sigue a la reserva, no al Entitlement
  // ─────────────────────────────────────────────
  describe('removeUserFromSchedule — refunding the payer', () => {
    function bookedSchedule(): Schedule {
      const schedule = buildSchedule();
      schedule.users = createMockCollection([user]);
      return schedule;
    }

    it('refunds the subscription the registration names, not a re-derived one', async () => {
      const charged = pack({ id: 'sub-pack-old', creditsUsed: 1 });
      paidBy = charged;
      // El Entitlement ha cambiado desde que reservó: re-derivar elegiría otra.
      entitlement = [pack({ id: 'sub-pack-new', creditsUsed: 1 }), unlimited()];
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 0 },
      });
      mockScheduleRepo.findOne.mockResolvedValue(bookedSchedule());

      await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      expect(mockEm.execute.mock.calls[0][1]).toEqual([
        'sub-pack-old',
        'comp-1',
      ]);
      expect(charged.creditsUsed).toBe(0);
    });

    it('records the refund in the history of the paying subscription with the schedule id', async () => {
      const charged = pack({ creditsUsed: 1 });
      paidBy = charged;
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 0 },
      });
      mockScheduleRepo.findOne.mockResolvedValue(bookedSchedule());

      await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(charged.metadata.history[0]).toMatchObject({
        event: 'credit_refunded',
        actor: 'user-1',
        scheduleId: 'sch-1',
      });
    });

    it('refunds a pack that closed between the booking and the unregistration', async () => {
      // Antes el reembolso re-derivaba el Entitlement, así que un pack cerrado
      // se quedaba el crédito. Paga quien pagó, aunque ya no esté vigente.
      const closed = pack({
        creditsUsed: 1,
        status: SubscriptionStatus.CANCELED,
      });
      paidBy = closed;
      entitlement = [];
      mockEm.execute.mockResolvedValue({
        affectedRows: 1,
        row: { credits_used: 0 },
      });
      mockScheduleRepo.findOne.mockResolvedValue(bookedSchedule());

      await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(closed.creditsUsed).toBe(0);
    });

    it('reads the registration without depending on the request company context', async () => {
      paidBy = pack({ creditsUsed: 1 });
      mockScheduleRepo.findOne.mockResolvedValue(bookedSchedule());

      await service.removeUserFromSchedule(member as any, 'sch-1');

      const call = mockEm.findOne.mock.calls.find(
        (c: any[]) => c[0] === ScheduleRegistration
      );
      expect(call[2]).toMatchObject({ filters: false });
    });

    it('refunds nothing when no subscription is recorded on the registration', async () => {
      paidBy = null;
      entitlement = [pack({ creditsUsed: 1 })];
      mockScheduleRepo.findOne.mockResolvedValue(bookedSchedule());

      const res = await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(res.success).toBe(true);
      expect(mockEm.execute).not.toHaveBeenCalled();
    });

    it('reads the registration before the member leaves the schedule', async () => {
      const schedule = bookedSchedule();
      paidBy = pack({ creditsUsed: 1 });
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await service.removeUserFromSchedule(member as any, 'sch-1');

      const lookedUp = mockEm.findOne.mock.calls.some(
        (c: any[]) => c[0] === ScheduleRegistration
      );
      expect(lookedUp).toBe(true);
      expect(schedule.users.getItems()).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────
  // Promoción desde la lista de espera
  // ─────────────────────────────────────────────
  describe('waitlist promotion — charging and recording the payer', () => {
    let promoted: User;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      // La notificación de promoción falla con el EM mockeado y se traga el
      // error por diseño; no es lo que se prueba aquí.
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      promoted = new User({} as any);
      promoted.id = 'user-2';
      promoted.schedules = createMockCollection([]);
      promoted.waitListSchedules = createMockCollection([]);

      mockEm.findOne.mockImplementation(async (entity: any, where: any) => {
        if (entity === User) {
          return where.id === 'user-2' ? promoted : user;
        }
        if (entity === Company) return { scheduleOptions };
        if (entity === ScheduleRegistration) {
          return where.user === 'user-1' && paidBy
            ? { paidBySubscription: paidBy }
            : null;
        }
        return null;
      });
    });

    afterEach(() => errorSpy.mockRestore());

    /** El que se va libera la única plaza; la clase ya empezó ⇒ no hay reembolso. */
    function scheduleWithWaitlist(): Schedule {
      const schedule = restrictedTo([PACK], {
        maxUsers: 1,
        startDate: moment().subtract(1, 'hour').valueOf(),
      });
      schedule.users = createMockCollection([user]);
      schedule.waitListUsers = createMockCollection([promoted]);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      return schedule;
    }

    it('charges the qualifying subscription of the promoted candidate', async () => {
      entitlement = [unlimited(), pack()];
      const schedule = scheduleWithWaitlist();

      await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(schedule.users.getItems().map((u: any) => u.id)).toEqual([
        'user-2',
      ]);
      expect(mockEm.execute).toHaveBeenCalledTimes(1);
      expect(mockEm.execute.mock.calls[0][1]).toEqual(['sub-pack', 'comp-1']);
    });

    it('records the charge against the promoted registration', async () => {
      entitlement = [pack()];
      scheduleWithWaitlist();

      await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(recordedCharge()).toEqual({
        where: { user: 'user-2', schedule: 'sch-1' },
        data: { paidBySubscription: 'sub-pack' },
      });
    });

    it('skips a candidate without credits and leaves the seat free', async () => {
      entitlement = [pack({ creditsUsed: 4 })];
      mockEm.execute.mockResolvedValue({ affectedRows: 0, row: undefined });
      const schedule = scheduleWithWaitlist();

      await service.removeUserFromSchedule(member as any, 'sch-1');

      expect(schedule.users.getItems()).toHaveLength(0);
      expect(schedule.waitListUsers.getItems()).toHaveLength(0);
      expect(recordedCharge()).toBeNull();
    });
  });
});
