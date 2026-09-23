import moment from 'moment';

import { Schedule } from '../../entities/Schedule';
import { ScheduleState, ScheduleType } from '../../types/enums';
import { createScheduleInXWeeks } from '../schedules.util';

describe('schedules.util - createScheduleInXWeeks', () => {
  let mockEntityManager: any;
  let mockScheduleProgrammed: any;

  beforeEach(() => {
    mockEntityManager = {
      findOne: jest.fn(),
      create: jest.fn(),
      persist: jest.fn(),
    };

    mockScheduleProgrammed = {
      startHour: '10:00',
      endHour: '11:00',
      maxUsers: 15,
      admin: { id: 'admin-1' },
      title: 'Yoga Flow',
      description: 'Morning yoga session',
      type: ScheduleType.STANDARD,
      age: 18,
      company: { id: 'company-1' },
    };
  });

  it('debería crear y persistir el Schedule si no existe uno previamente', async () => {
    // Arrange: findOne retorna null indicando que no existe
    mockEntityManager.findOne.mockResolvedValue(null);
    mockEntityManager.create.mockImplementation(
      (entityClass: any, data: any) => data
    );

    const now = moment('2026-06-07T08:00:00.000Z');
    const day = 0; // Domingo
    const weeksFromNow = 1;

    // Act
    await createScheduleInXWeeks(
      now,
      day,
      weeksFromNow,
      mockScheduleProgrammed as any,
      mockEntityManager as any
    );

    // Assert
    // El domingo de la semana siguiente a 2026-06-07 es 2026-06-14
    const expectedStartDate = now
      .clone()
      .add(1, 'weeks')
      .set({
        hour: 10,
        minute: 0,
        second: 0,
        millisecond: 0,
      })
      .toDate();
    const expectedEndDate = now
      .clone()
      .add(1, 'weeks')
      .set({
        hour: 11,
        minute: 0,
        second: 0,
        millisecond: 0,
      })
      .toDate();

    expect(mockEntityManager.findOne).toHaveBeenCalledWith(
      Schedule,
      {
        startDate: expectedStartDate,
        scheduleProgrammed: mockScheduleProgrammed,
      },
      { filters: false }
    );

    expect(mockEntityManager.create).toHaveBeenCalledWith(
      Schedule,
      expect.objectContaining({
        startDate: expectedStartDate,
        endDate: expectedEndDate,
        maxUsers: mockScheduleProgrammed.maxUsers,
        state: ScheduleState.AVAILABLE,
        admin: mockScheduleProgrammed.admin,
        title: mockScheduleProgrammed.title,
        description: mockScheduleProgrammed.description,
        type: mockScheduleProgrammed.type,
        age: mockScheduleProgrammed.age,
        scheduleProgrammed: mockScheduleProgrammed,
        company: mockScheduleProgrammed.company,
      })
    );

    expect(mockEntityManager.persist).toHaveBeenCalled();
  });

  it('debería retornar temprano sin crear ni persistir si ya existe un Schedule en esa fecha', async () => {
    // Arrange: findOne retorna un objeto simulado (existe)
    mockEntityManager.findOne.mockResolvedValue({ id: 'existing-schedule-id' });

    const now = moment('2026-06-07T08:00:00.000Z');
    const day = 0; // Domingo
    const weeksFromNow = 1;

    // Act
    await createScheduleInXWeeks(
      now,
      day,
      weeksFromNow,
      mockScheduleProgrammed as any,
      mockEntityManager as any
    );

    // Assert
    const expectedStartDate = now
      .clone()
      .add(1, 'weeks')
      .set({
        hour: 10,
        minute: 0,
        second: 0,
        millisecond: 0,
      })
      .toDate();

    expect(mockEntityManager.findOne).toHaveBeenCalledWith(
      Schedule,
      {
        startDate: expectedStartDate,
        scheduleProgrammed: mockScheduleProgrammed,
      },
      { filters: false }
    );

    expect(mockEntityManager.create).not.toHaveBeenCalled();
    expect(mockEntityManager.persist).not.toHaveBeenCalled();
  });

  /**
   * Issue #12: la plantilla siembra su restricción de planes en los schedules
   * que engendra; sin restricción, siguen naciendo abiertos.
   */
  describe('seeding the plan restriction from the template', () => {
    function createMockCollection(items: any[]): any {
      let current = [...items];
      return {
        getItems: jest.fn(() => current),
        set: jest.fn((newItems: any[]) => {
          current = [...newItems];
        }),
        isInitialized: jest.fn(() => true),
        init: jest.fn(async () => {}),
      };
    }

    it('debería sembrar los planes de la plantilla en el Schedule creado', async () => {
      const premiumPlan = { id: 'plan-premium' };
      mockEntityManager.findOne.mockResolvedValue(null);
      mockEntityManager.create.mockImplementation((_e: any, data: any) => ({
        ...data,
        allowedPlans: createMockCollection([]),
      }));
      mockScheduleProgrammed.allowedPlans = createMockCollection([premiumPlan]);

      let created: any;
      mockEntityManager.persist.mockImplementation((schedule: any) => {
        created = schedule;
      });

      await createScheduleInXWeeks(
        moment('2026-06-07T08:00:00.000Z'),
        0,
        1,
        mockScheduleProgrammed as any,
        mockEntityManager as any
      );

      expect(created.allowedPlans.getItems()).toEqual([premiumPlan]);
    });

    it('debería dejar el Schedule abierto cuando la plantilla no restringe', async () => {
      mockEntityManager.findOne.mockResolvedValue(null);
      mockEntityManager.create.mockImplementation((_e: any, data: any) => ({
        ...data,
        allowedPlans: createMockCollection([]),
      }));
      mockScheduleProgrammed.allowedPlans = createMockCollection([]);

      let created: any;
      mockEntityManager.persist.mockImplementation((schedule: any) => {
        created = schedule;
      });

      await createScheduleInXWeeks(
        moment('2026-06-07T08:00:00.000Z'),
        0,
        1,
        mockScheduleProgrammed as any,
        mockEntityManager as any
      );

      expect(created.allowedPlans.getItems()).toEqual([]);
    });
  });
});
