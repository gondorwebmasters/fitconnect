import moment from 'moment';

import { Company } from '../../entities/Company';
import { Schedule } from '../../entities/Schedule';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import {
  SchedulePlanAccessReason,
  ScheduleState,
  UserRoleEnum,
} from '../../types/enums';
import { ValidationError, VAL_ERRORS } from '../../utils/errors.util';
import { ScheduleService } from '../schedule.service';

/**
 * Tests del seam ScheduleService para **Restricted Schedule** — issue #8.
 *
 * Cada test fija una regla de ADR 0005: el gate se evalúa solo al inscribirse,
 * contra la suscripción vigente *ahora*, para todos los roles, y ordenado
 * detrás de aforo / límites de reserva para no tapar el motivo real.
 * Prior art: schedule.service.test.ts (EM y colecciones simuladas).
 */

// Helper to create mock collection (same shape as schedule.service.test.ts)
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
    set: jest.fn((newItems: any[]) => {
      items = [...newItems];
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

const BASIC_PLAN: any = { id: 'plan-basic', name: 'Básico' };
const PREMIUM_PLAN: any = { id: 'plan-premium', name: 'Premium' };
const UNLIMITED_PLAN: any = { id: 'plan-unlimited', name: 'Ilimitado' };

describe('ScheduleService — Restricted Schedule (plan restriction)', () => {
  let scheduleService: ScheduleService;
  let mockEntityManager: any;
  let mockScheduleRepo: any;
  let scheduleOptions: any;
  let subscriptions: any[];
  let user: User;
  let schedule: Schedule;

  /** Suscripción vigente ahora mismo al plan dado. */
  function liveSubscription(plan: any, userId = 'user-1'): any {
    return {
      id: `sub-${plan.id}`,
      user: userId,
      company: 'comp-1',
      plan,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: moment().subtract(5, 'days').toDate(),
      currentPeriodEnd: moment().add(25, 'days').toDate(),
    };
  }

  /** Suscripción Futura: su periodo aún no ha empezado. */
  function futureSubscription(plan: any, userId = 'user-1'): any {
    return {
      ...liveSubscription(plan, userId),
      id: `sub-future-${plan.id}`,
      currentPeriodStart: moment().add(10, 'days').toDate(),
      currentPeriodEnd: moment().add(40, 'days').toDate(),
    };
  }

  /** Reproduce el filtrado que hace la query real sobre las suscripciones. */
  function findSubscription(where: any): any {
    const from = where.currentPeriodStart?.$lte;
    const to = where.currentPeriodEnd?.$gte;

    return (
      subscriptions.find(
        sub =>
          sub.user === where.user &&
          sub.company === where.company &&
          where.status.$in.includes(sub.status) &&
          (!from || sub.currentPeriodStart <= from) &&
          (!to || sub.currentPeriodEnd >= to)
      ) ?? null
    );
  }

  function buildCurrentUser(contextRole = UserRoleEnum.STANDARD) {
    return {
      id: 'user-1',
      contextRole,
      activeCompanyId: 'comp-1',
    } as any;
  }

  /** Restringe el schedule a los planes dados. Sin argumentos ⇒ sin restricción. */
  function restrictTo(...plans: any[]) {
    schedule.allowedPlans = createMockCollection(plans);
  }

  beforeEach(() => {
    subscriptions = [];

    mockScheduleRepo = { findOne: jest.fn() };

    scheduleOptions = {
      id: 'opt-1',
      maxActiveReservations: 5,
      sameDayBookingAllowed: true,
      maxAdvanceBookingDays: 30,
    };

    user = new User({} as any);
    user.id = 'user-1';
    user.schedules = createMockCollection([]);
    user.waitListSchedules = createMockCollection([]);

    schedule = new Schedule({
      startDate: moment().add(1, 'day').valueOf(),
      maxUsers: 5,
      admin: { id: 'admin-1' } as any,
    } as any);
    schedule.id = 'sch-1';
    schedule.state = ScheduleState.AVAILABLE;
    schedule.users = createMockCollection([]);
    schedule.waitListUsers = createMockCollection([]);
    schedule.allowedPlans = createMockCollection([]);

    mockEntityManager = {
      getRepository: jest.fn(() => mockScheduleRepo),
      findOne: jest.fn(async (entity: any, where: any) => {
        if (entity === User) return user;
        if (entity === Company) return { scheduleOptions };
        if (entity === Subscription) return findSubscription(where);
        return null;
      }),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(async () => {}),
      create: jest.fn((entity: any, data: any) => ({ ...data, ...entity })),
      transactional: jest.fn(async (cb: any) => await cb(mockEntityManager)),
    };

    mockScheduleRepo.findOne.mockImplementation(async () => schedule);

    scheduleService = new ScheduleService(mockEntityManager as any);
  });

  describe('addUserToSchedule — unrestricted schedule', () => {
    it('should admit anyone and never look up a subscription when the schedule is unrestricted', async () => {
      const response = await scheduleService.addUserToSchedule(
        buildCurrentUser(),
        'sch-1'
      );

      expect(response.success).toBe(true);
      expect(schedule.users.getItems()).toHaveLength(1);
      expect(mockEntityManager.findOne).not.toHaveBeenCalledWith(
        Subscription,
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe('addUserToSchedule — restricted schedule', () => {
    it('should register the member when their live subscription is to an allowed plan', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(PREMIUM_PLAN)];

      const response = await scheduleService.addUserToSchedule(
        buildCurrentUser(),
        'sch-1'
      );

      expect(response.success).toBe(true);
      expect(schedule.users.getItems()).toHaveLength(1);
    });

    it('should register the member when they hold any one of several allowed plans', async () => {
      restrictTo(PREMIUM_PLAN, UNLIMITED_PLAN);
      subscriptions = [liveSubscription(UNLIMITED_PLAN)];

      const response = await scheduleService.addUserToSchedule(
        buildCurrentUser(),
        'sch-1'
      );

      expect(response.success).toBe(true);
      expect(schedule.users.getItems()).toHaveLength(1);
    });

    it('should refuse the member when their live plan is not in the allowed set', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE);

      expect(schedule.users.getItems()).toHaveLength(0);
      expect(schedule.waitListUsers.getItems()).toHaveLength(0);
    });

    it('should refuse the member when their only subscription to an allowed plan is a Future Subscription', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [futureSubscription(PREMIUM_PLAN)];

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE);

      expect(schedule.users.getItems()).toHaveLength(0);
    });

    it('should refuse the member when they have no live subscription at all', async () => {
      restrictTo(PREMIUM_PLAN);

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE);

      expect(schedule.users.getItems()).toHaveLength(0);
    });

    it('should refuse a coach registering themselves on the same terms, with no bypass', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];
      schedule.admin = { id: 'user-1' } as any;

      await expect(
        scheduleService.addUserToSchedule(
          buildCurrentUser(UserRoleEnum.COACH),
          'sch-1'
        )
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE);

      expect(schedule.users.getItems()).toHaveLength(0);
    });

    it('should refuse an administrator registering themselves on the same terms, with no bypass', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];

      await expect(
        scheduleService.addUserToSchedule(
          buildCurrentUser(UserRoleEnum.ADMIN),
          'sch-1'
        )
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE);

      expect(schedule.users.getItems()).toHaveLength(0);
    });

    it('should leave an already registered member untouched when the restriction is added afterwards', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];
      schedule.users = createMockCollection([user]);
      user.schedules = createMockCollection([schedule]);

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.USER_ALREADY_IN_SCHEDULE);

      expect(schedule.users.getItems()).toHaveLength(1);
    });
  });

  describe('addUserToSchedule — ordering against the other refusals', () => {
    it('should report the booking-limit refusal when the member is also non-qualifying', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];
      scheduleOptions.maxActiveReservations = 1;
      user.schedules = createMockCollection([
        { id: 'sch-other', state: ScheduleState.AVAILABLE },
      ]);

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.MAX_ACTIVE_RESERVATIONS_REACHED);
    });

    it('should resolve as capacity, not as a plan refusal, when the restricted schedule is full', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];
      schedule.maxUsers = 1;
      schedule.users = createMockCollection([{ id: 'user-2' }]);

      const response = await scheduleService.addUserToSchedule(
        buildCurrentUser(),
        'sch-1'
      );

      expect(response.message).toBe('User added to waitlist');
    });

    it('should refuse a cancelled schedule before ever considering the plan', async () => {
      restrictTo(PREMIUM_PLAN);
      schedule.state = ScheduleState.CANCELLED;

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.SCHEDULE_NOT_AVAILABLE);
    });
  });

  describe('getSchedulePlanAccess — the per-caller derived field', () => {
    it('should report registrable with no reason and no required plans when the schedule is unrestricted', async () => {
      const access = await scheduleService.getSchedulePlanAccess(
        buildCurrentUser(),
        schedule
      );

      expect(access).toEqual({
        canRegister: true,
        reason: null,
        requiredPlans: [],
      });
    });

    it('should report the required plans and PLAN_NOT_ALLOWED when the member does not qualify', async () => {
      restrictTo(PREMIUM_PLAN, UNLIMITED_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];

      const access = await scheduleService.getSchedulePlanAccess(
        buildCurrentUser(),
        schedule
      );

      expect(access.canRegister).toBe(false);
      expect(access.reason).toBe(SchedulePlanAccessReason.PLAN_NOT_ALLOWED);
      expect(access.requiredPlans).toEqual([PREMIUM_PLAN, UNLIMITED_PLAN]);
    });

    it('should report NO_LIVE_SUBSCRIPTION when the member has no live subscription', async () => {
      restrictTo(PREMIUM_PLAN);

      const access = await scheduleService.getSchedulePlanAccess(
        buildCurrentUser(),
        schedule
      );

      expect(access.canRegister).toBe(false);
      expect(access.reason).toBe(SchedulePlanAccessReason.NO_LIVE_SUBSCRIPTION);
      expect(access.requiredPlans).toEqual([PREMIUM_PLAN]);
    });

    it('should report registrable when the member qualifies', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(PREMIUM_PLAN)];

      const access = await scheduleService.getSchedulePlanAccess(
        buildCurrentUser(),
        schedule
      );

      expect(access.canRegister).toBe(true);
      expect(access.reason).toBeNull();
    });
  });

  describe('createSchedule — assigning the restriction', () => {
    function buildCreateInput(overrides: Record<string, any> = {}): any {
      return {
        currentUser: buildCurrentUser(UserRoleEnum.ADMIN),
        title: 'Clase Premium',
        description: 'Solo para Premium',
        startHour: '10:00',
        endHour: '11:00',
        days: [1],
        maxUsers: 10,
        age: null,
        admin: 'admin-1',
        type: 'standard',
        repeat: false,
        date: moment().add(1, 'day').format('YYYY-MM-DD'),
        ...overrides,
      };
    }

    beforeEach(() => {
      mockEntityManager.getReference = jest.fn((_e: any, id: string) => ({
        id,
      }));
      mockEntityManager.create = jest.fn((_e: any, data: any) => ({
        ...data,
        allowedPlans: createMockCollection([]),
      }));
    });

    it('should restrict the created schedule when given plans of the company', async () => {
      mockEntityManager.find = jest.fn(async () => [PREMIUM_PLAN]);

      const response: any = await scheduleService.createSchedule(
        buildCreateInput({ allowedPlanIds: [PREMIUM_PLAN.id] })
      );

      expect(response.success).toBe(true);
      expect(response.schedules[0].allowedPlans.getItems()).toEqual([
        PREMIUM_PLAN,
      ]);
    });

    it('should create an unrestricted schedule when no plans are given', async () => {
      const response: any =
        await scheduleService.createSchedule(buildCreateInput());

      expect(response.success).toBe(true);
      expect(response.schedules[0].allowedPlans.getItems()).toEqual([]);
    });

    it('should reject a plan that does not belong to the company, keeping tenancy', async () => {
      mockEntityManager.find = jest.fn(async () => []);

      await expect(
        scheduleService.createSchedule(
          buildCreateInput({ allowedPlanIds: ['plan-de-otra-empresa'] })
        )
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_IN_COMPANY);
    });

    it('should refuse loudly, not silently drop the restriction, when the schedule repeats', async () => {
      await expect(
        scheduleService.createSchedule(
          buildCreateInput({
            repeat: true,
            allowedPlanIds: [PREMIUM_PLAN.id],
          })
        )
      ).rejects.toThrow(VAL_ERRORS.PLAN_RESTRICTION_NOT_SUPPORTED_ON_REPEAT);
    });
  });

  describe('updateSchedule — assigning the restriction', () => {
    it('should replace the allowed plans when given plans of the schedule company', async () => {
      mockEntityManager.find = jest.fn(async () => [
        PREMIUM_PLAN,
        UNLIMITED_PLAN,
      ]);

      await scheduleService.updateSchedule({
        currentUser: buildCurrentUser(UserRoleEnum.ADMIN),
        id: 'sch-1',
        allowedPlanIds: [PREMIUM_PLAN.id, UNLIMITED_PLAN.id],
      });

      expect(schedule.allowedPlans.getItems()).toEqual([
        PREMIUM_PLAN,
        UNLIMITED_PLAN,
      ]);
    });

    it('should clear the restriction when given an empty list', async () => {
      restrictTo(PREMIUM_PLAN);
      mockEntityManager.find = jest.fn(async () => []);

      await scheduleService.updateSchedule({
        currentUser: buildCurrentUser(UserRoleEnum.ADMIN),
        id: 'sch-1',
        allowedPlanIds: [],
      });

      expect(schedule.allowedPlans.getItems()).toEqual([]);
    });

    it('should leave the restriction untouched when the list is omitted', async () => {
      restrictTo(PREMIUM_PLAN);

      await scheduleService.updateSchedule({
        currentUser: buildCurrentUser(UserRoleEnum.ADMIN),
        id: 'sch-1',
        title: 'Otro título',
      });

      expect(schedule.allowedPlans.getItems()).toEqual([PREMIUM_PLAN]);
    });

    it('should reject a plan that does not belong to the company, keeping tenancy', async () => {
      // El filtro companyContext hace que el plan de otra empresa no aparezca.
      mockEntityManager.find = jest.fn(async () => []);

      await expect(
        scheduleService.updateSchedule({
          currentUser: buildCurrentUser(UserRoleEnum.ADMIN),
          id: 'sch-1',
          allowedPlanIds: ['plan-de-otra-empresa'],
        })
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_IN_COMPANY);
    });
  });
});

describe('ScheduleService — Restricted Schedule error vocabulary', () => {
  it('should expose a validation error distinct from the capacity and booking-limit ones', () => {
    expect(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE).toBeDefined();
    expect(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE).not.toBe(
      VAL_ERRORS.SCHEDULE_FULL
    );
    expect(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE).not.toBe(
      VAL_ERRORS.MAX_ACTIVE_RESERVATIONS_REACHED
    );
    expect(
      new ValidationError(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE)
    ).toBeInstanceOf(ValidationError);
  });
});
