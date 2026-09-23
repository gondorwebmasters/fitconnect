import moment from 'moment';

import { Schedule } from '../../entities/Schedule';
import { ScheduleProgrammed } from '../../entities/ScheduleProgrammed';
import { ScheduleState, ScheduleType, UserRoleEnum } from '../../types/enums';
import { VAL_ERRORS } from '../../utils/errors.util';
import { ScheduleService } from '../schedule.service';

/**
 * Tests del seam ScheduleService para la restricción de planes sobre la
 * **plantilla semanal** (Schedule Programmed) — issue #12.
 *
 * La plantilla **siembra** la restricción en los schedules que engendra, y
 * editarla **pisa** la de todos los schedules futuros de los días que
 * conserva, igual que ya hace con título, aforo, tipo o coach. Lo pasado no se
 * toca. Prior art: schedule.plan-restriction.test.ts.
 *
 * La siembra se comprueba de punta a punta: el servicio crea la plantilla de
 * verdad y se mira lo que acaba en los schedules engendrados, no en los
 * argumentos de una función simulada.
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

function buildCurrentUser(contextRole = UserRoleEnum.ADMIN) {
  return { id: 'user-1', contextRole, activeCompanyId: 'comp-1' } as any;
}

/** Schedule futuro/pasado engendrado por la plantilla, en el día dado. */
function buildSpawnedSchedule(
  id: string,
  startDate: Date,
  allowedPlans: any[] = []
): Schedule {
  const schedule = new Schedule({
    startDate,
    endDate: moment(startDate).add(1, 'hour').toDate(),
    maxUsers: 10,
    state: ScheduleState.AVAILABLE,
    admin: { id: 'admin-1' } as any,
    title: 'Yoga',
    description: 'Yoga',
    age: null,
  } as any);
  schedule.id = id;
  schedule.state = ScheduleState.AVAILABLE;
  schedule.users = createMockCollection([]);
  schedule.waitListUsers = createMockCollection([]);
  schedule.allowedPlans = createMockCollection(allowedPlans);
  return schedule;
}

describe('ScheduleService — plan restriction on the Schedule Programmed', () => {
  let scheduleService: ScheduleService;
  let mockEntityManager: any;
  let mockScheduleRepo: any;
  let mockProgrammedRepo: any;
  let scheduleProgrammed: any;
  let spawned: Schedule[];
  let plansInCompany: any[];
  /** Schedules que el servicio ha engendrado durante el test. */
  let createdSchedules: any[];

  beforeEach(() => {
    jest.clearAllMocks();

    plansInCompany = [BASIC_PLAN, PREMIUM_PLAN];
    spawned = [];
    createdSchedules = [];

    scheduleProgrammed = {
      id: 'sp-1',
      daysOfWeek: [1, 3],
      startHour: '10:00',
      endHour: '11:00',
      maxUsers: 10,
      title: 'Yoga',
      description: 'Yoga',
      type: ScheduleType.STANDARD,
      age: null,
      admin: { id: 'admin-1' },
      company: { id: 'comp-1' },
      allowedPlans: createMockCollection([]),
      schedules: createMockCollection([]),
    };

    mockScheduleRepo = {
      findOne: jest.fn(
        async (where: any) => spawned.find(s => s.id === where.id) ?? null
      ),
    };
    mockProgrammedRepo = {
      findOne: jest.fn(async () => scheduleProgrammed),
      findAll: jest.fn(async () => [scheduleProgrammed]),
    };

    mockEntityManager = {
      getRepository: jest.fn((entity: any) =>
        entity === ScheduleProgrammed ? mockProgrammedRepo : mockScheduleRepo
      ),
      findOne: jest.fn(async () => null),
      find: jest.fn(async (_entity: any, where: any) =>
        plansInCompany.filter(p => where.id.$in.includes(p.id))
      ),
      getReference: jest.fn((_e: any, id: string) => ({ id })),
      create: jest.fn((_e: any, data: any) => {
        const entity = { ...data, allowedPlans: createMockCollection([]) };
        // Un schedule engendrado se distingue de la plantilla por su fecha.
        if (data.startDate) {
          createdSchedules.push(entity);
        }
        return entity;
      }),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(async () => {}),
      transactional: jest.fn(async (cb: any) => await cb(mockEntityManager)),
    };

    scheduleService = new ScheduleService(mockEntityManager as any);
  });

  describe('createSchedule with repeat — seeding the template', () => {
    function buildCreateInput(overrides: any = {}) {
      return {
        currentUser: buildCurrentUser(),
        title: 'Yoga',
        description: 'Yoga',
        age: null,
        startHour: '10:00',
        endHour: '11:00',
        days: [1, 3],
        maxUsers: 10,
        admin: 'admin-1',
        type: ScheduleType.STANDARD,
        repeat: true,
        ...overrides,
      };
    }

    it('should seed the restriction into every schedule the template spawns', async () => {
      const response = await scheduleService.createSchedule(
        buildCreateInput({ allowedPlanIds: [PREMIUM_PLAN.id] })
      );

      expect(response.success).toBe(true);
      expect(createdSchedules.length).toBeGreaterThan(0);
      for (const schedule of createdSchedules) {
        expect(schedule.allowedPlans.getItems()).toEqual([PREMIUM_PLAN]);
      }
    });

    it('should keep spawning unrestricted schedules when no plans are given', async () => {
      await scheduleService.createSchedule(buildCreateInput());

      expect(createdSchedules.length).toBeGreaterThan(0);
      for (const schedule of createdSchedules) {
        expect(schedule.allowedPlans.getItems()).toEqual([]);
      }
    });

    it('should reject a plan of another company, keeping tenancy', async () => {
      await expect(
        scheduleService.createSchedule(
          buildCreateInput({ allowedPlanIds: ['plan-de-otra-empresa'] })
        )
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_IN_COMPANY);

      expect(createdSchedules).toHaveLength(0);
    });
  });

  describe('updateScheduleProgrammed — propagating the restriction', () => {
    /** Lunes futuro, miércoles futuro y un lunes ya pasado. */
    function buildSpawnedWeek(allowedPlans: any[] = []) {
      const nextMonday = moment().add(1, 'week').day(1).hour(10).toDate();
      const nextWednesday = moment().add(1, 'week').day(3).hour(10).toDate();
      const lastMonday = moment().subtract(1, 'week').day(1).hour(10).toDate();

      spawned = [
        buildSpawnedSchedule('sch-future-mon', nextMonday, allowedPlans),
        buildSpawnedSchedule('sch-future-wed', nextWednesday, allowedPlans),
        buildSpawnedSchedule('sch-past-mon', lastMonday, allowedPlans),
      ];
      scheduleProgrammed.schedules = createMockCollection(spawned);
    }

    function findSpawned(id: string): Schedule {
      return spawned.find(s => s.id === id)!;
    }

    it('should set the restriction on the template and overwrite every future schedule', async () => {
      buildSpawnedWeek();

      await scheduleService.updateScheduleProgrammed({
        currentUser: buildCurrentUser(),
        id: 'sp-1',
        allowedPlanIds: [PREMIUM_PLAN.id],
      } as any);

      expect(scheduleProgrammed.allowedPlans.getItems()).toEqual([
        PREMIUM_PLAN,
      ]);
      expect(findSpawned('sch-future-mon').allowedPlans.getItems()).toEqual([
        PREMIUM_PLAN,
      ]);
      expect(findSpawned('sch-future-wed').allowedPlans.getItems()).toEqual([
        PREMIUM_PLAN,
      ]);
    });

    it('should never touch a past schedule', async () => {
      buildSpawnedWeek([BASIC_PLAN]);

      await scheduleService.updateScheduleProgrammed({
        currentUser: buildCurrentUser(),
        id: 'sp-1',
        allowedPlanIds: [PREMIUM_PLAN.id],
      } as any);

      expect(findSpawned('sch-past-mon').allowedPlans.getItems()).toEqual([
        BASIC_PLAN,
      ]);
    });

    it('should overwrite a schedule that had diverged from the template', async () => {
      buildSpawnedWeek();
      findSpawned('sch-future-mon').allowedPlans = createMockCollection([
        BASIC_PLAN,
      ]);

      await scheduleService.updateScheduleProgrammed({
        currentUser: buildCurrentUser(),
        id: 'sp-1',
        allowedPlanIds: [PREMIUM_PLAN.id],
      } as any);

      expect(findSpawned('sch-future-mon').allowedPlans.getItems()).toEqual([
        PREMIUM_PLAN,
      ]);
    });

    it('should clear the restriction everywhere when given an empty list', async () => {
      buildSpawnedWeek([PREMIUM_PLAN]);
      scheduleProgrammed.allowedPlans = createMockCollection([PREMIUM_PLAN]);

      await scheduleService.updateScheduleProgrammed({
        currentUser: buildCurrentUser(),
        id: 'sp-1',
        allowedPlanIds: [],
      } as any);

      expect(scheduleProgrammed.allowedPlans.getItems()).toEqual([]);
      expect(findSpawned('sch-future-mon').allowedPlans.getItems()).toEqual([]);
    });

    it('should leave the template and its divergent schedules alone when the list is omitted', async () => {
      buildSpawnedWeek();
      scheduleProgrammed.allowedPlans = createMockCollection([PREMIUM_PLAN]);
      findSpawned('sch-future-mon').allowedPlans = createMockCollection([
        BASIC_PLAN,
      ]);

      await scheduleService.updateScheduleProgrammed({
        currentUser: buildCurrentUser(),
        id: 'sp-1',
        title: 'Yoga avanzado',
      } as any);

      expect(scheduleProgrammed.allowedPlans.getItems()).toEqual([
        PREMIUM_PLAN,
      ]);
      expect(findSpawned('sch-future-mon').allowedPlans.getItems()).toEqual([
        BASIC_PLAN,
      ]);
    });

    it('should reject a plan of another company, keeping tenancy', async () => {
      buildSpawnedWeek();

      await expect(
        scheduleService.updateScheduleProgrammed({
          currentUser: buildCurrentUser(),
          id: 'sp-1',
          allowedPlanIds: ['plan-de-otra-empresa'],
        } as any)
      ).rejects.toThrow(VAL_ERRORS.PLAN_NOT_IN_COMPANY);
    });

    it('should seed the restriction into the schedules of a newly added day', async () => {
      buildSpawnedWeek();

      await scheduleService.updateScheduleProgrammed({
        currentUser: buildCurrentUser(),
        id: 'sp-1',
        daysOfWeek: [1, 3, 5],
        allowedPlanIds: [PREMIUM_PLAN.id],
      } as any);

      // Los schedules del día nuevo nacen de la plantilla ya actualizada.
      expect(createdSchedules.length).toBeGreaterThan(0);
      for (const schedule of createdSchedules) {
        expect(moment(schedule.startDate).day()).toBe(5);
        expect(schedule.allowedPlans.getItems()).toEqual([PREMIUM_PLAN]);
      }
    });
  });
});
