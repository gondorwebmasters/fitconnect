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
import { NotificationService } from '../notification.service';
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

/** Suscripción vigente ahora mismo al plan dado. */
function liveSubscription(plan: any, userId = 'user-1'): any {
  return {
    id: `sub-${plan.id}-${userId}`,
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
    id: `sub-future-${plan.id}-${userId}`,
    currentPeriodStart: moment().add(10, 'days').toDate(),
    currentPeriodEnd: moment().add(40, 'days').toDate(),
  };
}

/** Reproduce el filtrado que hace la query real sobre las suscripciones. */
function matchSubscription(subscriptions: any[], where: any): any {
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

describe('ScheduleService — Restricted Schedule (plan restriction)', () => {
  let scheduleService: ScheduleService;
  let mockEntityManager: any;
  let mockScheduleRepo: any;
  let scheduleOptions: any;
  let subscriptions: any[];
  let user: User;
  let schedule: Schedule;

  /** Reproduce el filtrado que hace la query real sobre las suscripciones. */
  function findSubscription(where: any): any {
    return matchSubscription(subscriptions, where);
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

    it('should refuse a cancelled schedule before ever considering the plan', async () => {
      restrictTo(PREMIUM_PLAN);
      schedule.state = ScheduleState.CANCELLED;

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.SCHEDULE_NOT_AVAILABLE);
    });
  });

  /**
   * Issue #11: la restricción alcanza a la lista de espera. Un miembro que
   * nunca podría ocupar la plaza tampoco espera por ella, así que el aforo ya
   * no es la vía por la que un no elegible se cuela en un schedule
   * restringido.
   */
  describe('addUserToSchedule — joining the waitlist', () => {
    /** Deja el schedule lleno, que es lo que manda a la lista de espera. */
    function fillSchedule() {
      schedule.maxUsers = 1;
      schedule.users = createMockCollection([{ id: 'user-2' }]);
    }

    it('should refuse a non-qualifying member with the same error used at registration', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];
      fillSchedule();

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE);

      expect(schedule.waitListUsers.getItems()).toHaveLength(0);
      expect(user.waitListSchedules.getItems()).toHaveLength(0);
    });

    it('should refuse a member whose only allowed plan is a Future Subscription', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [futureSubscription(PREMIUM_PLAN)];
      fillSchedule();

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE);

      expect(schedule.waitListUsers.getItems()).toHaveLength(0);
    });

    it('should let a qualifying member join the waitlist as before', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(PREMIUM_PLAN)];
      fillSchedule();

      const response = await scheduleService.addUserToSchedule(
        buildCurrentUser(),
        'sch-1'
      );

      expect(response.message).toBe('User added to waitlist');
      expect(schedule.waitListUsers.getItems()).toHaveLength(1);
      expect(user.waitListSchedules.getItems()).toHaveLength(1);
    });

    it('should leave the waitlist of an unrestricted schedule exactly as it was', async () => {
      fillSchedule();

      const response = await scheduleService.addUserToSchedule(
        buildCurrentUser(),
        'sch-1'
      );

      expect(response.message).toBe('User added to waitlist');
      expect(mockEntityManager.findOne).not.toHaveBeenCalledWith(
        Subscription,
        expect.anything(),
        expect.anything()
      );
    });

    it('should report the booking-limit refusal before the plan one, as at registration', async () => {
      restrictTo(PREMIUM_PLAN);
      subscriptions = [liveSubscription(BASIC_PLAN)];
      fillSchedule();
      scheduleOptions.maxActiveReservations = 1;
      user.schedules = createMockCollection([
        { id: 'sch-other', state: ScheduleState.AVAILABLE },
      ]);

      await expect(
        scheduleService.addUserToSchedule(buildCurrentUser(), 'sch-1')
      ).rejects.toThrow(VAL_ERRORS.MAX_ACTIVE_RESERVATIONS_REACHED);
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

    // `repeat: true` lleva la restricción a la plantilla semanal: lo cubre
    // scheduleProgrammed.plan-restriction.test.ts (issue #12).
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

/**
 * Issue #11 — la restricción se vuelve a comprobar al promocionar.
 *
 * Entre apuntarse a la lista y que se libere la plaza, un candidato puede
 * haber cambiado de plan o haberse quedado sin suscripción. Igual que la regla
 * de Session Credit de ADR 0004: quien ya no cualifica se **salta y sale de
 * esta lista**, la plaza cae al siguiente, y si no cualifica nadie se queda
 * libre. Perder la elegibilidad nunca quita una plaza ya ocupada.
 */
describe('ScheduleService — Restricted Schedule on the Waitlist (promotion)', () => {
  let scheduleService: ScheduleService;
  let mockEntityManager: any;
  let mockScheduleRepo: any;
  let scheduleOptions: any;
  let subscriptions: any[];
  let users: Record<string, User>;
  let schedule: Schedule;
  let userToRemove: User;

  /** Candidato de la lista de espera, sin reservas ni otras listas. */
  function buildCandidate(id: string): User {
    const candidate = new User({} as any);
    candidate.id = id;
    candidate.schedules = createMockCollection([]);
    candidate.waitListSchedules = createMockCollection([]);
    users[id] = candidate;
    return candidate;
  }

  /** Pone a estos candidatos en la lista de espera del schedule, en orden. */
  function waitlist(...candidates: User[]) {
    schedule.waitListUsers = createMockCollection(candidates);
    for (const candidate of candidates) {
      candidate.waitListSchedules.add(schedule);
    }
  }

  /** Libera la plaza que ocupaba `userToRemove`, disparando la promoción. */
  async function freeTheSeat() {
    return await scheduleService.removeUserFromSchedule(
      { id: 'user-admin', contextRole: UserRoleEnum.ADMIN } as any,
      'sch-1',
      'user-to-remove'
    );
  }

  const enrolled = () => schedule.users.getItems().map((u: any) => u.id);
  const waiting = () => schedule.waitListUsers.getItems().map((u: any) => u.id);

  beforeEach(() => {
    subscriptions = [];
    users = {};

    scheduleOptions = {
      id: 'opt-1',
      maxActiveReservations: 5,
      sameDayBookingAllowed: true,
      maxAdvanceBookingDays: 30,
    };

    userToRemove = new User({} as any);
    userToRemove.id = 'user-to-remove';
    userToRemove.schedules = createMockCollection([]);
    userToRemove.waitListSchedules = createMockCollection([]);
    users['user-to-remove'] = userToRemove;

    schedule = new Schedule({
      startDate: moment().add(1, 'day').valueOf(),
      maxUsers: 1,
      admin: { id: 'admin-1' } as any,
    } as any);
    schedule.id = 'sch-1';
    schedule.state = ScheduleState.AVAILABLE;
    schedule.company = { id: 'comp-1' } as any;
    schedule.users = createMockCollection([userToRemove]);
    schedule.waitListUsers = createMockCollection([]);
    schedule.allowedPlans = createMockCollection([]);

    mockScheduleRepo = { findOne: jest.fn(async () => schedule) };

    mockEntityManager = {
      getRepository: jest.fn(() => mockScheduleRepo),
      findOne: jest.fn(async (entity: any, where: any) => {
        if (entity === User) return users[where.id] ?? null;
        if (entity === Company) return { scheduleOptions };
        if (entity === Subscription)
          return matchSubscription(subscriptions, where);
        return null;
      }),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(async () => {}),
      transactional: jest.fn(async (cb: any) => await cb(mockEntityManager)),
    };

    // La notificación de promoción es un efecto colateral ajeno a esta regla y
    // el servicio real se la traga en un try/catch: silenciarla deja ver lo
    // que sí se está midiendo.
    jest
      .spyOn(NotificationService.prototype, 'sendToUser')
      .mockResolvedValue(undefined as any);

    scheduleService = new ScheduleService(mockEntityManager as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should skip a candidate who has lost eligibility and give the seat to the next one', async () => {
    schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
    const lapsed = buildCandidate('user-lapsed');
    const qualifying = buildCandidate('user-qualifying');
    waitlist(lapsed, qualifying);
    subscriptions = [
      liveSubscription(BASIC_PLAN, 'user-lapsed'),
      liveSubscription(PREMIUM_PLAN, 'user-qualifying'),
    ];

    const response = await freeTheSeat();

    expect(response.success).toBe(true);
    expect(enrolled()).toEqual(['user-qualifying']);
    expect(waiting()).toEqual([]);
  });

  it('should drop the skipped candidate from this waitlist', async () => {
    schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
    const lapsed = buildCandidate('user-lapsed');
    const qualifying = buildCandidate('user-qualifying');
    waitlist(lapsed, qualifying);
    subscriptions = [liveSubscription(PREMIUM_PLAN, 'user-qualifying')];

    await freeTheSeat();

    expect(waiting()).not.toContain('user-lapsed');
    expect(
      lapsed.waitListSchedules.getItems().some((s: any) => s.id === 'sch-1')
    ).toBe(false);
  });

  it('should not touch the skipped candidate other waitlists, unlike a booking-limit skip', async () => {
    schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
    const lapsed = buildCandidate('user-lapsed');
    const otherWaitlist = {
      id: 'sch-other',
      startDate: moment().add(2, 'days').valueOf(),
      waitListUsers: createMockCollection([{ id: 'user-lapsed' }]),
    };
    lapsed.waitListSchedules = createMockCollection([otherWaitlist]);
    waitlist(lapsed);
    subscriptions = [liveSubscription(BASIC_PLAN, 'user-lapsed')];

    await freeTheSeat();

    expect(otherWaitlist.waitListUsers.getItems()).toHaveLength(1);
  });

  it('should leave the seat free when no candidate qualifies', async () => {
    schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
    waitlist(buildCandidate('user-a'), buildCandidate('user-b'));
    subscriptions = [
      liveSubscription(BASIC_PLAN, 'user-a'),
      futureSubscription(PREMIUM_PLAN, 'user-b'),
    ];

    const response = await freeTheSeat();

    expect(response.success).toBe(true);
    expect(enrolled()).toEqual([]);
    expect(waiting()).toEqual([]);
  });

  it('should skip a candidate with no live subscription at all', async () => {
    schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
    const noSub = buildCandidate('user-no-sub');
    const qualifying = buildCandidate('user-qualifying');
    waitlist(noSub, qualifying);
    subscriptions = [liveSubscription(PREMIUM_PLAN, 'user-qualifying')];

    await freeTheSeat();

    expect(enrolled()).toEqual(['user-qualifying']);
  });

  it('should promote the first candidate on an unrestricted schedule, never asking about plans', async () => {
    const first = buildCandidate('user-first');
    buildCandidate('user-second');
    waitlist(first, users['user-second']);

    await freeTheSeat();

    expect(enrolled()).toEqual(['user-first']);
    expect(waiting()).toEqual(['user-second']);
    expect(mockEntityManager.findOne).not.toHaveBeenCalledWith(
      Subscription,
      expect.anything(),
      expect.anything()
    );
  });

  it('should keep the promoted member enrolled even if they would no longer qualify later', async () => {
    // Perder la elegibilidad nunca revoca una plaza ya ocupada: el gate solo
    // decide en el momento de ocuparla.
    schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
    const qualifying = buildCandidate('user-qualifying');
    waitlist(qualifying);
    subscriptions = [liveSubscription(PREMIUM_PLAN, 'user-qualifying')];

    await freeTheSeat();
    subscriptions = [];

    expect(enrolled()).toEqual(['user-qualifying']);
  });

  it('should leave the seat free and keep the candidate waiting when eligibility cannot be determined', async () => {
    // Un fallo transitorio no debe costarle el sitio a quien sí cualifica:
    // de la lista de espera no se vuelve, de una plaza vacía sí.
    schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
    const candidate = buildCandidate('user-candidate');
    waitlist(candidate);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockEntityManager.findOne.mockImplementation(
      async (entity: any, where: any) => {
        if (entity === Subscription) throw new Error('connection reset');
        if (entity === User) return users[where.id] ?? null;
        if (entity === Company) return { scheduleOptions };
        return null;
      }
    );

    await freeTheSeat();

    expect(enrolled()).toEqual([]);
    expect(waiting()).toEqual(['user-candidate']);
  });

  /**
   * ADR 0004 manda que un candidato sin créditos también se salte. Ese
   * descuento todavía no está en `ScheduleService` (issue #5), así que lo que
   * se fija aquí es el **orden**: los límites de reserva se evalúan antes que
   * el plan, y cada motivo arrastra su propia consecuencia — el límite limpia
   * las demás listas del candidato, el plan solo lo saca de esta.
   */
  describe('interaction with the other skip rules', () => {
    it('should skip for the booking limit, not for the plan, when both apply', async () => {
      schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
      scheduleOptions.maxActiveReservations = 1;
      const overbooked = buildCandidate('user-overbooked');
      overbooked.schedules = createMockCollection([
        { id: 'sch-elsewhere', state: ScheduleState.AVAILABLE },
      ]);
      const otherWaitlist = {
        id: 'sch-other',
        startDate: moment().add(2, 'days').valueOf(),
        waitListUsers: createMockCollection([{ id: 'user-overbooked' }]),
      };
      overbooked.waitListSchedules = createMockCollection([otherWaitlist]);
      // No cualifica por ninguno de los dos motivos.
      subscriptions = [liveSubscription(BASIC_PLAN, 'user-overbooked')];
      waitlist(overbooked);

      await freeTheSeat();

      expect(enrolled()).toEqual([]);
      // La consecuencia del límite, no la del plan: sale de las demás listas.
      expect(otherWaitlist.waitListUsers.getItems()).toHaveLength(0);
    });

    it('should skip for the plan when the candidate is within their booking limits', async () => {
      schedule.allowedPlans = createMockCollection([PREMIUM_PLAN]);
      const lapsed = buildCandidate('user-lapsed');
      const otherWaitlist = {
        id: 'sch-other',
        startDate: moment().add(2, 'days').valueOf(),
        waitListUsers: createMockCollection([{ id: 'user-lapsed' }]),
      };
      lapsed.waitListSchedules = createMockCollection([otherWaitlist]);
      subscriptions = [liveSubscription(BASIC_PLAN, 'user-lapsed')];
      waitlist(lapsed);

      await freeTheSeat();

      expect(enrolled()).toEqual([]);
      expect(waiting()).toEqual([]);
      // La consecuencia del plan: sigue esperando donde sí puede entrar.
      expect(otherWaitlist.waitListUsers.getItems()).toHaveLength(1);
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
