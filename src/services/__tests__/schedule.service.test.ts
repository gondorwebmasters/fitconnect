import { LoadStrategy } from '@mikro-orm/core';
import moment from 'moment';

import { Company } from '../../entities/Company';
import { Schedule } from '../../entities/Schedule';
import { ScheduleProgrammed } from '../../entities/ScheduleProgrammed';
import { User } from '../../entities/User';
import { ScheduleState, UserRoleEnum } from '../../types/enums';
import { ValidationError } from '../../utils/errors.util';
import { ScheduleService } from '../schedule.service';

// Helper to create mock collection
function createMockCollection<T>(initialItems: T[] = []): any {
  let items = [...initialItems];
  const coll = {
    getItems: jest.fn(() => items),
    contains: jest.fn((item: any) => items.some((i: any) => i.id === item.id)),
    add: jest.fn((...newItems: any[]) => {
      // Avoid duplicate adds
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

describe('ScheduleService - Waitlist and Booking Limits logic', () => {
  let scheduleService: ScheduleService;
  let mockEntityManager: any;
  let mockScheduleRepo: any;
  let scheduleOptions: any;

  beforeEach(() => {
    mockScheduleRepo = {
      findOne: jest.fn(),
    };

    mockEntityManager = {
      getRepository: jest.fn(() => mockScheduleRepo),
      findOne: jest.fn(),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(async () => {}),
      create: jest.fn((entity: any, data: any) => ({ ...data, ...entity })),
      transactional: jest.fn(async (cb: any) => {
        return await cb(mockEntityManager);
      }),
    };

    scheduleService = new ScheduleService(mockEntityManager as any);

    scheduleOptions = {
      id: 'opt-1',
      maxActiveReservations: 2,
      sameDayBookingAllowed: false,
      maxAdvanceBookingDays: 7,
    };
  });

  describe('addUserToSchedule', () => {
    it('should throw error when max active reservations are reached', async () => {
      const currentUser = { id: 'user-1', contextRole: UserRoleEnum.STANDARD };

      const user = new User({} as any);
      user.id = 'user-1';
      user.schedules = createMockCollection([
        { id: 'sch-old-1', state: ScheduleState.AVAILABLE },
        { id: 'sch-old-2', state: ScheduleState.AVAILABLE },
      ]);
      user.waitListSchedules = createMockCollection([]);

      const schedule = new Schedule({
        startDate: moment().add(1, 'day').valueOf(),
        maxUsers: 5,
        admin: { id: 'admin-1' } as any,
      } as any);
      schedule.id = 'sch-new';
      schedule.state = ScheduleState.AVAILABLE;
      schedule.users = createMockCollection([]);
      schedule.waitListUsers = createMockCollection([]);

      mockEntityManager.findOne.mockImplementation((entity: any) => {
        if (entity === User) return user;
        if (entity === Company) return { scheduleOptions };
        return null;
      });
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await expect(
        scheduleService.addUserToSchedule(currentUser as any, 'sch-new')
      ).rejects.toThrow(ValidationError);
    });

    it('should throw error when same day booking is not allowed and user already has a booking that day', async () => {
      const currentUser = { id: 'user-1', contextRole: UserRoleEnum.STANDARD };

      const user = new User({} as any);
      user.id = 'user-1';
      const today = moment().add(1, 'day').startOf('day').add(10, 'hours');
      user.schedules = createMockCollection([
        {
          id: 'sch-old-1',
          state: ScheduleState.AVAILABLE,
          startDate: today.valueOf(),
        },
      ]);
      user.waitListSchedules = createMockCollection([]);

      const schedule = new Schedule({
        startDate: today.clone().add(2, 'hours').valueOf(),
        maxUsers: 5,
        admin: { id: 'admin-1' } as any,
      } as any);
      schedule.id = 'sch-new';
      schedule.state = ScheduleState.AVAILABLE;
      schedule.users = createMockCollection([]);
      schedule.waitListUsers = createMockCollection([]);

      mockEntityManager.findOne.mockImplementation((entity: any) => {
        if (entity === User) return user;
        if (entity === Company) return { scheduleOptions };
        return null;
      });
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await expect(
        scheduleService.addUserToSchedule(currentUser as any, 'sch-new')
      ).rejects.toThrow(ValidationError);
    });

    it('should clean up other waitlists when user reaches limits by booking', async () => {
      const currentUser = { id: 'user-1', contextRole: UserRoleEnum.STANDARD };

      const user = new User({} as any);
      user.id = 'user-1';

      const oldSchedule = { id: 'sch-old-1', state: ScheduleState.AVAILABLE };
      user.schedules = createMockCollection([oldSchedule]);

      const waitlistSchedule1 = {
        id: 'sch-wait-1',
        startDate: moment().add(2, 'days').valueOf(),
        waitListUsers: createMockCollection([{ id: 'user-1' }]),
      };

      const waitlistSchedule2 = {
        id: 'sch-wait-2',
        startDate: moment().add(3, 'days').valueOf(),
        waitListUsers: createMockCollection([{ id: 'user-1' }]),
      };

      user.waitListSchedules = createMockCollection([
        waitlistSchedule1,
        waitlistSchedule2,
      ]);

      const schedule = new Schedule({
        startDate: moment().add(1, 'day').valueOf(),
        maxUsers: 5,
        admin: { id: 'admin-1' } as any,
      } as any);
      schedule.id = 'sch-new';
      schedule.state = ScheduleState.AVAILABLE;
      schedule.users = createMockCollection([]);
      schedule.waitListUsers = createMockCollection([]);

      mockEntityManager.findOne.mockImplementation((entity: any) => {
        if (entity === User) return user;
        if (entity === Company) return { scheduleOptions };
        return null;
      });
      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const response = await scheduleService.addUserToSchedule(
        currentUser as any,
        'sch-new'
      );

      expect(response.success).toBe(true);
      // Limits reached: max reservations = 2.
      // So user should be removed from all other waitlists!
      expect(waitlistSchedule1.waitListUsers.getItems().length).toBe(0);
      expect(waitlistSchedule2.waitListUsers.getItems().length).toBe(0);
      expect(mockEntityManager.persist).toHaveBeenCalledWith(waitlistSchedule1);
      expect(mockEntityManager.persist).toHaveBeenCalledWith(waitlistSchedule2);
    });
  });

  describe('removeUserFromSchedule & promotion', () => {
    it('should promote the next valid user from waitlist and skip invalid ones', async () => {
      const currentUser = { id: 'user-admin', contextRole: UserRoleEnum.ADMIN };

      const userToRemove = new User({} as any);
      userToRemove.id = 'user-to-remove';

      // User 1 on waitlist: has reached limits (2 bookings), should be skipped and cleaned up
      const waitlistUser1 = new User({} as any);
      waitlistUser1.id = 'user-wl-1';
      waitlistUser1.schedules = createMockCollection([
        { id: 's1', state: ScheduleState.AVAILABLE },
        { id: 's2', state: ScheduleState.AVAILABLE },
      ]);
      const otherWaitlistSchedule = {
        id: 'sch-other-wait',
        startDate: moment().add(2, 'days').valueOf(),
        waitListUsers: createMockCollection([{ id: 'user-wl-1' }]),
      };
      waitlistUser1.waitListSchedules = createMockCollection([
        otherWaitlistSchedule,
      ]);

      // User 2 on waitlist: valid, should be promoted
      const waitlistUser2 = new User({} as any);
      waitlistUser2.id = 'user-wl-2';
      waitlistUser2.schedules = createMockCollection([]);
      waitlistUser2.waitListSchedules = createMockCollection([]);

      const schedule = new Schedule({
        startDate: moment().add(1, 'day').valueOf(),
        maxUsers: 5,
        admin: { id: 'admin-1' } as any,
      } as any);
      schedule.id = 'sch-target';
      schedule.state = ScheduleState.AVAILABLE;

      // Initially schedule contains userToRemove, and others on waitlist
      schedule.users = createMockCollection([userToRemove]);
      schedule.waitListUsers = createMockCollection([
        waitlistUser1,
        waitlistUser2,
      ]);

      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      mockEntityManager.findOne.mockImplementation(
        (entity: any, query: any) => {
          if (entity === User) {
            if (query.id === 'user-to-remove') return userToRemove;
            if (query.id === 'user-wl-1') return waitlistUser1;
            if (query.id === 'user-wl-2') return waitlistUser2;
          }
          if (entity === Company) return { scheduleOptions };
          return null;
        }
      );

      // Call removeUserFromSchedule
      const response = await scheduleService.removeUserFromSchedule(
        currentUser as any,
        'sch-target',
        'user-to-remove'
      );

      expect(response.success).toBe(true);

      // User 1 should be removed from schedule waitlist and from otherWaitlistSchedule waitlist
      expect(
        schedule.waitListUsers.getItems().some((u: any) => u.id === 'user-wl-1')
      ).toBe(false);
      expect(otherWaitlistSchedule.waitListUsers.getItems().length).toBe(0);
      expect(mockEntityManager.persist).toHaveBeenCalledWith(
        otherWaitlistSchedule
      );

      // User 2 should be promoted to users
      expect(
        schedule.users.getItems().some((u: any) => u.id === 'user-wl-2')
      ).toBe(true);
      expect(
        schedule.waitListUsers.getItems().some((u: any) => u.id === 'user-wl-2')
      ).toBe(false);
    });
  });

  describe('removeSchedule', () => {
    // Borrar con inscritos/waitlist es una cancelación del gym (issue #111):
    // se reembolsa el crédito a los inscritos y se elimina. Ver
    // schedule.gym-cancel-refund.test.ts.
    it('should remove schedule with registered users (gym cancellation)', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };
      const schedule = new Schedule({
        admin: { id: 'admin-1' } as any,
      } as any);
      schedule.id = 'sch-1';
      schedule.users = createMockCollection([{ id: 'user-1' }]);
      schedule.waitListUsers = createMockCollection([]);

      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const response = await scheduleService.removeSchedule(
        currentUser as any,
        'sch-1'
      );
      expect(response.success).toBe(true);
      expect(mockEntityManager.remove).toHaveBeenCalledWith(schedule);
    });

    it('should remove schedule with users in waitlist', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };
      const schedule = new Schedule({
        admin: { id: 'admin-1' } as any,
      } as any);
      schedule.id = 'sch-1';
      schedule.users = createMockCollection([]);
      schedule.waitListUsers = createMockCollection([{ id: 'user-1' }]);

      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      const response = await scheduleService.removeSchedule(
        currentUser as any,
        'sch-1'
      );
      expect(response.success).toBe(true);
      expect(mockEntityManager.remove).toHaveBeenCalledWith(schedule);
    });

    it('should remove schedule successfully when there are no users and no waitlisted users', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };
      const schedule = new Schedule({
        admin: { id: 'admin-1' } as any,
      } as any);
      schedule.id = 'sch-1';
      schedule.users = createMockCollection([]);
      schedule.waitListUsers = createMockCollection([]);

      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockEntityManager.remove = jest.fn();

      const response = await scheduleService.removeSchedule(
        currentUser as any,
        'sch-1'
      );
      expect(response.success).toBe(true);
      expect(mockEntityManager.remove).toHaveBeenCalledWith(schedule);
      expect(mockEntityManager.flush).toHaveBeenCalled();
    });
  });

  describe('updateSchedule', () => {
    it('should throw ValidationError when new maxUsers is less than current registered users', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };
      const schedule = new Schedule({
        admin: { id: 'admin-1' } as any,
        maxUsers: 5,
      } as any);
      schedule.id = 'sch-1';
      schedule.users = createMockCollection([
        { id: 'user-1' },
        { id: 'user-2' },
      ]);
      schedule.waitListUsers = createMockCollection([]);

      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      await expect(
        scheduleService.updateSchedule({
          currentUser: currentUser as any,
          id: 'sch-1',
          maxUsers: 1,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('should update maxUsers successfully and promote users from waitlist when capacity increases', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };
      const schedule = new Schedule({
        admin: { id: 'admin-1' } as any,
        maxUsers: 2,
      } as any);
      schedule.id = 'sch-1';

      const user1 = {
        id: 'u-1',
        schedules: createMockCollection(),
        waitListSchedules: createMockCollection(),
        pushTokens: createMockCollection(),
      };
      const user2 = {
        id: 'u-2',
        schedules: createMockCollection(),
        waitListSchedules: createMockCollection(),
        pushTokens: createMockCollection(),
      };

      schedule.users = createMockCollection([
        { id: 'registered-1' },
        { id: 'registered-2' },
      ]);
      schedule.waitListUsers = createMockCollection([user1, user2]);

      mockScheduleRepo.findOne.mockResolvedValue(schedule);

      mockEntityManager.findOne.mockImplementation(
        (entity: any, query: any) => {
          if (entity === User) {
            if (query.id === 'u-1') return user1;
            if (query.id === 'u-2') return user2;
          }
          if (entity === Company) return { scheduleOptions };
          return null;
        }
      );

      const response = await scheduleService.updateSchedule({
        currentUser: currentUser as any,
        id: 'sch-1',
        maxUsers: 4,
      });

      expect(response.success).toBe(true);
      expect(schedule.maxUsers).toBe(4);
      expect(schedule.users.getItems().some(u => u.id === 'u-1')).toBe(true);
      expect(schedule.users.getItems().some(u => u.id === 'u-2')).toBe(true);
      expect(schedule.waitListUsers.length).toBe(0);
    });
  });

  describe('updateScheduleProgrammed', () => {
    let mockScheduleProgrammedRepo: any;

    beforeEach(() => {
      mockScheduleProgrammedRepo = {
        findOne: jest.fn(),
      };
      const originalGetRepository = mockEntityManager.getRepository;
      mockEntityManager.getRepository = jest.fn((entity: any) => {
        if (entity === ScheduleProgrammed) return mockScheduleProgrammedRepo;
        return originalGetRepository(entity);
      });
    });

    it('should cancel existing future schedules and create new ones when days changed', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };

      const admin = { id: 'admin-1' } as any;
      const company = { id: 'comp-1' } as any;

      const scheduleProgrammed = {
        id: 'sp-1',
        daysOfWeek: [1],
        startHour: '09:00',
        endHour: '10:00',
        maxUsers: 5,
        admin,
        title: 'Original Programmed Title',
        description: 'Original Desc',
        company,
        schedules: createMockCollection(),
      } as any;

      const futureSchedule = {
        id: 'sch-future-1',
        startDate: moment().day(1).add(2, 'weeks').toDate(),
        endDate: moment().day(1).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Programmed Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'enrolled-user-1' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;
      scheduleProgrammed.schedules.add(futureSchedule);

      mockScheduleProgrammedRepo.findOne.mockResolvedValue(scheduleProgrammed);
      mockScheduleRepo.findOne.mockResolvedValue(futureSchedule);

      const changeStatusSpy = jest
        .spyOn(scheduleService, 'changeScheduleStatus')
        .mockResolvedValue({ success: true } as any);

      mockEntityManager.findOne.mockResolvedValue(null);

      const response = await scheduleService.updateScheduleProgrammed({
        currentUser: currentUser as any,
        id: 'sp-1',
        daysOfWeek: [2],
        title: 'New Programmed Title',
      });

      expect(response.success).toBe(true);
      expect(scheduleProgrammed.daysOfWeek).toEqual([2]);
      expect(scheduleProgrammed.title).toBe('New Programmed Title');

      expect(changeStatusSpy).toHaveBeenCalledWith(
        currentUser,
        'sch-future-1',
        ScheduleState.CANCELLED,
        'Cambio de días en la programación semanal',
        expect.any(Object)
      );

      changeStatusSpy.mockRestore();
    });

    it('should cancel only removed days, update kept days, and create new days when daysOfWeek changes', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };

      const admin = { id: 'admin-1' } as any;
      const company = { id: 'comp-1' } as any;

      const scheduleProgrammed = {
        id: 'sp-1',
        daysOfWeek: [1, 2], // Mon, Tue
        startHour: '09:00',
        endHour: '10:00',
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        company,
        schedules: createMockCollection(),
      } as any;

      // Future schedule for Monday (day 1) - kept day
      const mondaySchedule = {
        id: 'sch-monday',
        startDate: moment().day(1).add(2, 'weeks').toDate(),
        endDate: moment().day(1).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'user-1' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;

      // Future schedule for Tuesday (day 2) - removed day
      const tuesdaySchedule = {
        id: 'sch-tuesday',
        startDate: moment().day(2).add(2, 'weeks').toDate(),
        endDate: moment().day(2).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'user-2' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;

      scheduleProgrammed.schedules.add(mondaySchedule);
      scheduleProgrammed.schedules.add(tuesdaySchedule);

      mockScheduleProgrammedRepo.findOne.mockResolvedValue(scheduleProgrammed);
      mockScheduleRepo.findOne.mockImplementation((criteria: any) => {
        if (criteria.id === 'sch-monday')
          return Promise.resolve(mondaySchedule);
        if (criteria.id === 'sch-tuesday')
          return Promise.resolve(tuesdaySchedule);
        return Promise.resolve(null);
      });

      const changeStatusSpy = jest
        .spyOn(scheduleService, 'changeScheduleStatus')
        .mockResolvedValue({ success: true } as any);

      const updateScheduleSpy = jest
        .spyOn(scheduleService, 'updateSchedule')
        .mockResolvedValue({ success: true } as any);

      mockEntityManager.findOne.mockResolvedValue(null);

      // Change from Mon, Tue [1, 2] to Mon, Wed [1, 3]
      const response = await scheduleService.updateScheduleProgrammed({
        currentUser: currentUser as any,
        id: 'sp-1',
        daysOfWeek: [1, 3], // Monday kept, Tuesday removed, Wednesday added
        title: 'New Title',
      });

      expect(response.success).toBe(true);
      expect(scheduleProgrammed.daysOfWeek).toEqual([1, 3]);

      // Tuesday (day 2) is removed, so it must be cancelled
      expect(changeStatusSpy).toHaveBeenCalledWith(
        currentUser,
        'sch-tuesday',
        ScheduleState.CANCELLED,
        'Cambio de días en la programación semanal',
        expect.any(Object)
      );
      // Monday (day 1) is kept, so it should not be cancelled
      expect(changeStatusSpy).not.toHaveBeenCalledWith(
        currentUser,
        'sch-monday',
        expect.any(String),
        expect.any(String),
        expect.any(Object)
      );

      // Monday (day 1) must be updated in place
      expect(updateScheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sch-monday',
          title: 'New Title',
        }),
        expect.any(Object)
      );

      changeStatusSpy.mockRestore();
      updateScheduleSpy.mockRestore();
    });

    it('should cancel nothing and only create new days when days are added', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };

      const admin = { id: 'admin-1' } as any;
      const company = { id: 'comp-1' } as any;

      const scheduleProgrammed = {
        id: 'sp-1',
        daysOfWeek: [1], // Mon
        startHour: '09:00',
        endHour: '10:00',
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        company,
        schedules: createMockCollection(),
      } as any;

      const mondaySchedule = {
        id: 'sch-monday',
        startDate: moment().day(1).add(2, 'weeks').toDate(),
        endDate: moment().day(1).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'user-1' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;

      scheduleProgrammed.schedules.add(mondaySchedule);

      mockScheduleProgrammedRepo.findOne.mockResolvedValue(scheduleProgrammed);
      mockScheduleRepo.findOne.mockResolvedValue(mondaySchedule);

      const changeStatusSpy = jest
        .spyOn(scheduleService, 'changeScheduleStatus')
        .mockResolvedValue({ success: true } as any);

      const updateScheduleSpy = jest
        .spyOn(scheduleService, 'updateSchedule')
        .mockResolvedValue({ success: true } as any);

      mockEntityManager.findOne.mockResolvedValue(null);

      // Change from Mon [1] to Mon, Tue [1, 2]
      const response = await scheduleService.updateScheduleProgrammed({
        currentUser: currentUser as any,
        id: 'sp-1',
        daysOfWeek: [1, 2],
        title: 'New Title',
      });

      expect(response.success).toBe(true);
      expect(scheduleProgrammed.daysOfWeek).toEqual([1, 2]);

      // Nothing should be cancelled
      expect(changeStatusSpy).not.toHaveBeenCalled();

      // Monday (day 1) must be updated in place
      expect(updateScheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sch-monday',
          title: 'New Title',
        }),
        expect.any(Object)
      );

      changeStatusSpy.mockRestore();
      updateScheduleSpy.mockRestore();
    });

    it('should create nothing and cancel removed days when days are removed', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };

      const admin = { id: 'admin-1' } as any;
      const company = { id: 'comp-1' } as any;

      const scheduleProgrammed = {
        id: 'sp-1',
        daysOfWeek: [1, 2], // Mon, Tue
        startHour: '09:00',
        endHour: '10:00',
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        company,
        schedules: createMockCollection(),
      } as any;

      const mondaySchedule = {
        id: 'sch-monday',
        startDate: moment().day(1).add(2, 'weeks').toDate(),
        endDate: moment().day(1).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'user-1' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;

      const tuesdaySchedule = {
        id: 'sch-tuesday',
        startDate: moment().day(2).add(2, 'weeks').toDate(),
        endDate: moment().day(2).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'user-2' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;

      scheduleProgrammed.schedules.add(mondaySchedule);
      scheduleProgrammed.schedules.add(tuesdaySchedule);

      mockScheduleProgrammedRepo.findOne.mockResolvedValue(scheduleProgrammed);
      mockScheduleRepo.findOne.mockImplementation((criteria: any) => {
        if (criteria.id === 'sch-monday')
          return Promise.resolve(mondaySchedule);
        if (criteria.id === 'sch-tuesday')
          return Promise.resolve(tuesdaySchedule);
        return Promise.resolve(null);
      });

      const changeStatusSpy = jest
        .spyOn(scheduleService, 'changeScheduleStatus')
        .mockResolvedValue({ success: true } as any);

      const updateScheduleSpy = jest
        .spyOn(scheduleService, 'updateSchedule')
        .mockResolvedValue({ success: true } as any);

      mockEntityManager.findOne.mockResolvedValue(null);

      // Change from Mon, Tue [1, 2] to Mon [1]
      const response = await scheduleService.updateScheduleProgrammed({
        currentUser: currentUser as any,
        id: 'sp-1',
        daysOfWeek: [1],
        title: 'New Title',
      });

      expect(response.success).toBe(true);
      expect(scheduleProgrammed.daysOfWeek).toEqual([1]);

      // Tuesday (day 2) is removed, so it must be cancelled
      expect(changeStatusSpy).toHaveBeenCalledWith(
        currentUser,
        'sch-tuesday',
        ScheduleState.CANCELLED,
        'Cambio de días en la programación semanal',
        expect.any(Object)
      );

      // Monday (day 1) is kept, so it should not be cancelled and should be updated
      expect(changeStatusSpy).not.toHaveBeenCalledWith(
        currentUser,
        'sch-monday',
        expect.any(String),
        expect.any(String),
        expect.any(Object)
      );
      expect(updateScheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sch-monday',
          title: 'New Title',
        }),
        expect.any(Object)
      );

      changeStatusSpy.mockRestore();
      updateScheduleSpy.mockRestore();
    });

    it('should update existing future schedules in place when days did not change', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };

      const admin = { id: 'admin-1' } as any;
      const company = { id: 'comp-1' } as any;

      const scheduleProgrammed = {
        id: 'sp-1',
        daysOfWeek: [1],
        startHour: '09:00',
        endHour: '10:00',
        maxUsers: 5,
        admin,
        title: 'Original Programmed Title',
        description: 'Original Desc',
        company,
        schedules: createMockCollection(),
      } as any;

      const futureSchedule = {
        id: 'sch-future-1',
        startDate: moment().day(1).add(2, 'weeks').toDate(),
        endDate: moment().day(1).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Programmed Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'enrolled-user-1' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;
      scheduleProgrammed.schedules.add(futureSchedule);

      mockScheduleProgrammedRepo.findOne.mockResolvedValue(scheduleProgrammed);
      mockScheduleRepo.findOne.mockResolvedValue(futureSchedule);

      const updateScheduleSpy = jest
        .spyOn(scheduleService, 'updateSchedule')
        .mockResolvedValue({ success: true } as any);

      const response = await scheduleService.updateScheduleProgrammed({
        currentUser: currentUser as any,
        id: 'sp-1',
        title: 'New Programmed Title',
      });

      expect(response.success).toBe(true);
      expect(scheduleProgrammed.title).toBe('New Programmed Title');

      expect(updateScheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sch-future-1',
          title: 'New Programmed Title',
        }),
        expect.any(Object)
      );

      updateScheduleSpy.mockRestore();
    });

    it('should delete removed days instead of cancelling when future schedules have no users and no waitlisted users', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };

      const admin = { id: 'admin-1' } as any;
      const company = { id: 'comp-1' } as any;

      const scheduleProgrammed = {
        id: 'sp-1',
        daysOfWeek: [1, 2], // Mon, Tue
        startHour: '09:00',
        endHour: '10:00',
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        company,
        schedules: createMockCollection(),
      } as any;

      const mondaySchedule = {
        id: 'sch-monday',
        startDate: moment().day(1).add(2, 'weeks').toDate(),
        endDate: moment().day(1).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'user-1' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;

      // Tuesday schedule has no users and no waitlist users
      const tuesdaySchedule = {
        id: 'sch-tuesday',
        startDate: moment().day(2).add(2, 'weeks').toDate(),
        endDate: moment().day(2).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection(),
        waitListUsers: createMockCollection(),
        company,
      } as any;

      scheduleProgrammed.schedules.add(mondaySchedule);
      scheduleProgrammed.schedules.add(tuesdaySchedule);

      mockScheduleProgrammedRepo.findOne.mockResolvedValue(scheduleProgrammed);
      mockScheduleRepo.findOne.mockImplementation((criteria: any) => {
        if (criteria.id === 'sch-monday')
          return Promise.resolve(mondaySchedule);
        if (criteria.id === 'sch-tuesday')
          return Promise.resolve(tuesdaySchedule);
        return Promise.resolve(null);
      });

      const changeStatusSpy = jest
        .spyOn(scheduleService, 'changeScheduleStatus')
        .mockResolvedValue({ success: true } as any);

      const updateScheduleSpy = jest
        .spyOn(scheduleService, 'updateSchedule')
        .mockResolvedValue({ success: true } as any);

      mockEntityManager.findOne.mockResolvedValue(null);

      // Change from Mon, Tue [1, 2] to Mon [1]
      const response = await scheduleService.updateScheduleProgrammed({
        currentUser: currentUser as any,
        id: 'sp-1',
        daysOfWeek: [1],
        title: 'New Title',
      });

      expect(response.success).toBe(true);
      expect(scheduleProgrammed.daysOfWeek).toEqual([1]);

      // Tuesday (day 2) is removed. Since it has no users, it should be deleted, not cancelled.
      expect(changeStatusSpy).not.toHaveBeenCalledWith(
        currentUser,
        'sch-tuesday',
        expect.any(String),
        expect.any(String),
        expect.any(Object)
      );

      expect(mockEntityManager.remove).toHaveBeenCalledWith(tuesdaySchedule);

      changeStatusSpy.mockRestore();
      updateScheduleSpy.mockRestore();
    });

    it('should cancel removed days when future schedules have waitlist users but no registered users', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };

      const admin = { id: 'admin-1' } as any;
      const company = { id: 'comp-1' } as any;

      const scheduleProgrammed = {
        id: 'sp-1',
        daysOfWeek: [1, 2], // Mon, Tue
        startHour: '09:00',
        endHour: '10:00',
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        company,
        schedules: createMockCollection(),
      } as any;

      const mondaySchedule = {
        id: 'sch-monday',
        startDate: moment().day(1).add(2, 'weeks').toDate(),
        endDate: moment().day(1).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'user-1' }]),
        waitListUsers: createMockCollection(),
        company,
      } as any;

      // Tuesday schedule has no regular users, but has 1 user in waitlist
      const tuesdaySchedule = {
        id: 'sch-tuesday',
        startDate: moment().day(2).add(2, 'weeks').toDate(),
        endDate: moment().day(2).add(2, 'weeks').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        title: 'Original Title',
        description: 'Original Desc',
        state: ScheduleState.AVAILABLE,
        users: createMockCollection(),
        waitListUsers: createMockCollection([{ id: 'waitlisted-user-1' }]),
        company,
      } as any;

      scheduleProgrammed.schedules.add(mondaySchedule);
      scheduleProgrammed.schedules.add(tuesdaySchedule);

      mockScheduleProgrammedRepo.findOne.mockResolvedValue(scheduleProgrammed);
      mockScheduleRepo.findOne.mockImplementation((criteria: any) => {
        if (criteria.id === 'sch-monday')
          return Promise.resolve(mondaySchedule);
        if (criteria.id === 'sch-tuesday')
          return Promise.resolve(tuesdaySchedule);
        return Promise.resolve(null);
      });

      const changeStatusSpy = jest
        .spyOn(scheduleService, 'changeScheduleStatus')
        .mockResolvedValue({ success: true } as any);

      const updateScheduleSpy = jest
        .spyOn(scheduleService, 'updateSchedule')
        .mockResolvedValue({ success: true } as any);

      mockEntityManager.findOne.mockResolvedValue(null);

      // Change from Mon, Tue [1, 2] to Mon [1]
      const response = await scheduleService.updateScheduleProgrammed({
        currentUser: currentUser as any,
        id: 'sp-1',
        daysOfWeek: [1],
        title: 'New Title',
      });

      expect(response.success).toBe(true);
      expect(scheduleProgrammed.daysOfWeek).toEqual([1]);

      // Tuesday (day 2) is removed. Since it has waitlist users, it must be cancelled.
      expect(changeStatusSpy).toHaveBeenCalledWith(
        currentUser,
        'sch-tuesday',
        ScheduleState.CANCELLED,
        'Cambio de días en la programación semanal',
        expect.any(Object)
      );

      expect(mockEntityManager.remove).not.toHaveBeenCalledWith(
        tuesdaySchedule
      );

      changeStatusSpy.mockRestore();
      updateScheduleSpy.mockRestore();
    });
  });

  describe('deleteSchedulesProgrammed', () => {
    let mockScheduleProgrammedRepo: any;

    beforeEach(() => {
      mockScheduleProgrammedRepo = {
        findOne: jest.fn(),
      };
      const originalGetRepository = mockEntityManager.getRepository;
      mockEntityManager.getRepository = jest.fn((entity: any) => {
        if (entity === ScheduleProgrammed) return mockScheduleProgrammedRepo;
        return originalGetRepository(entity);
      });
    });

    it('should delete empty future schedules and cancel future schedules with users/waitlist', async () => {
      const currentUser = { id: 'admin-1', contextRole: UserRoleEnum.ADMIN };
      const admin = { id: 'admin-1' } as any;
      const company = { id: 'comp-1' } as any;

      const scheduleProgrammed = {
        id: 'sp-1',
        daysOfWeek: [1],
        startHour: '09:00',
        endHour: '10:00',
        maxUsers: 5,
        admin,
        title: 'Title',
        description: 'Desc',
        company,
        schedules: createMockCollection(),
      } as any;

      // 1. Past schedule (should be unlinked, not deleted)
      const pastSchedule = {
        id: 'sch-past',
        startDate: moment().subtract(1, 'day').toDate(),
        endDate: moment().subtract(1, 'day').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        state: ScheduleState.AVAILABLE,
        users: createMockCollection(),
        waitListUsers: createMockCollection(),
        scheduleProgrammed,
      } as any;

      // 2. Future schedule with enrolled users (should be cancelled and unlinked)
      const futureWithUsers = {
        id: 'sch-future-users',
        startDate: moment().add(2, 'days').toDate(),
        endDate: moment().add(2, 'days').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        state: ScheduleState.AVAILABLE,
        users: createMockCollection([{ id: 'user-1' }]),
        waitListUsers: createMockCollection(),
        scheduleProgrammed,
      } as any;

      // 3. Future schedule with waitlisted users (should be cancelled and unlinked)
      const futureWithWaitlist = {
        id: 'sch-future-waitlist',
        startDate: moment().add(3, 'days').toDate(),
        endDate: moment().add(3, 'days').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        state: ScheduleState.AVAILABLE,
        users: createMockCollection(),
        waitListUsers: createMockCollection([{ id: 'user-2' }]),
        scheduleProgrammed,
      } as any;

      // 4. Future schedule empty (should be physically deleted)
      const futureEmpty = {
        id: 'sch-future-empty',
        startDate: moment().add(4, 'days').toDate(),
        endDate: moment().add(4, 'days').add(1, 'hour').toDate(),
        maxUsers: 5,
        admin,
        state: ScheduleState.AVAILABLE,
        users: createMockCollection(),
        waitListUsers: createMockCollection(),
        scheduleProgrammed,
      } as any;

      scheduleProgrammed.schedules.add(pastSchedule);
      scheduleProgrammed.schedules.add(futureWithUsers);
      scheduleProgrammed.schedules.add(futureWithWaitlist);
      scheduleProgrammed.schedules.add(futureEmpty);

      mockScheduleProgrammedRepo.findOne.mockResolvedValue(scheduleProgrammed);

      const changeStatusSpy = jest
        .spyOn(scheduleService, 'changeScheduleStatus')
        .mockResolvedValue({ success: true } as any);

      const response = await scheduleService.deleteSchedulesProgrammed(
        currentUser as any,
        ['sp-1']
      );

      expect(response.success).toBe(true);

      // Verify that changeScheduleStatus was called for future sessions with users or waitlist
      expect(changeStatusSpy).toHaveBeenCalledWith(
        currentUser,
        'sch-future-users',
        ScheduleState.CANCELLED,
        'Cambio en la programación semanal',
        expect.any(Object)
      );

      expect(changeStatusSpy).toHaveBeenCalledWith(
        currentUser,
        'sch-future-waitlist',
        ScheduleState.CANCELLED,
        'Cambio en la programación semanal',
        expect.any(Object)
      );

      // Verify empty future schedule was deleted
      expect(mockEntityManager.remove).toHaveBeenCalledWith(futureEmpty);

      // Verify past schedule was unlinked
      expect(pastSchedule.scheduleProgrammed).toBeUndefined();

      // Verify future schedules with users/waitlist were unlinked
      expect(futureWithUsers.scheduleProgrammed).toBeUndefined();
      expect(futureWithWaitlist.scheduleProgrammed).toBeUndefined();

      // Verify scheduleProgrammed itself was deleted
      expect(mockEntityManager.remove).toHaveBeenCalledWith(scheduleProgrammed);

      changeStatusSpy.mockRestore();
    });
  });
});

describe('ScheduleService - getSchedulesResumeRange', () => {
  let scheduleService: ScheduleService;
  let mockEntityManager: any;
  let qb: any;

  const currentUser = {
    id: 'u1',
    activeCompanyId: 'c1',
    contextRole: UserRoleEnum.STANDARD,
  } as any;

  // Chainable QueryBuilder mock: every builder method returns `qb`, and the two
  // terminal calls (applyFilters / execute) are async.
  const makeQb = () => {
    const builder: any = {};
    for (const m of [
      'select',
      'addSelect',
      'leftJoin',
      'where',
      'groupBy',
      'orderBy',
    ]) {
      builder[m] = jest.fn(() => builder);
    }
    builder.applyFilters = jest.fn(async () => {});
    builder.execute = jest.fn(async () => []);
    return builder;
  };

  beforeEach(() => {
    qb = makeQb();
    mockEntityManager = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => qb),
    };
    scheduleService = new ScheduleService(mockEntityManager as any);
  });

  it('maps QueryBuilder rows to the resume shape and returns scheduleOptions', async () => {
    const start = moment('2026-01-01').toDate();
    const end = moment('2026-01-14').toDate();
    mockEntityManager.findOne.mockResolvedValue({
      scheduleOptions: { id: 'opt-1', maxActiveReservations: 2 },
    });
    // execute() maps columns to entity property names; COUNT comes back as a
    // bigint string from node-postgres.
    qb.execute.mockResolvedValue([
      {
        id: 's1',
        startDate: start,
        maxUsers: 10,
        state: ScheduleState.AVAILABLE,
        ocupancy: '3',
      },
      {
        id: 's2',
        startDate: end,
        maxUsers: 5,
        state: ScheduleState.CANCELLED,
        ocupancy: '0',
      },
    ]);

    const res: any = await scheduleService.getSchedulesResumeRange(
      currentUser,
      start,
      end
    );

    expect(res.success).toBe(true);
    expect(res.schedulesResume).toEqual([
      {
        id: 's1',
        startDate: start,
        maxUsers: 10,
        state: ScheduleState.AVAILABLE,
        ocupancy: 3, // normalised to a number
      },
      {
        id: 's2',
        startDate: end,
        maxUsers: 5,
        state: ScheduleState.CANCELLED,
        ocupancy: 0,
      },
    ]);
    expect(res.scheduleOptions).toEqual({ id: 'opt-1', maxActiveReservations: 2 });
  });

  it('resolves schedules + ocupancy in a single query (one execute)', async () => {
    mockEntityManager.findOne.mockResolvedValue(null);

    await scheduleService.getSchedulesResumeRange(
      currentUser,
      new Date(),
      new Date()
    );

    expect(qb.execute).toHaveBeenCalledTimes(1);
    expect(qb.leftJoin).toHaveBeenCalledWith('s.users', 'u');
  });

  it('applies entity filters so the query stays company-scoped (v6 QB does not auto-apply)', async () => {
    mockEntityManager.findOne.mockResolvedValue(null);

    await scheduleService.getSchedulesResumeRange(
      currentUser,
      new Date(),
      new Date()
    );

    // Regression guard: dropping applyFilters() would leak schedules across tenants.
    expect(qb.applyFilters).toHaveBeenCalledTimes(1);
    expect(qb.applyFilters.mock.invocationCallOrder[0]).toBeLessThan(
      qb.execute.mock.invocationCallOrder[0]
    );
  });

  it('returns null scheduleOptions when no company is found', async () => {
    mockEntityManager.findOne.mockResolvedValue(null);

    const res: any = await scheduleService.getSchedulesResumeRange(
      currentUser,
      new Date(),
      new Date()
    );

    expect(res.success).toBe(true);
    expect(res.schedulesResume).toEqual([]);
    expect(res.scheduleOptions).toBeNull();
  });

  it('throws when there is no authenticated user', async () => {
    await expect(
      scheduleService.getSchedulesResumeRange(
        null as any,
        new Date(),
        new Date()
      )
    ).rejects.toThrow();
  });
});

describe('ScheduleService - getSchedulesRange', () => {
  let scheduleService: ScheduleService;
  let mockEntityManager: any;
  let scheduleRepo: any;

  const currentUser = {
    id: 'u1',
    activeCompanyId: 'c1',
    contextRole: UserRoleEnum.STANDARD,
  } as any;

  beforeEach(() => {
    scheduleRepo = { find: jest.fn(async () => []) };
    mockEntityManager = {
      getRepository: jest.fn(() => scheduleRepo),
      populate: jest.fn(async () => {}),
      getReference: jest.fn((_entity: any, id: string) => ({ id })),
    };
    scheduleService = new ScheduleService(mockEntityManager as any);
  });

  it('loads users + admin JOINED in one query and waitListUsers via select-in (2 round-trips, no cartesian)', async () => {
    await scheduleService.getSchedulesRange(
      currentUser,
      new Date(),
      new Date()
    );

    // Round-trip 1: a single find joining the to-one (admin) and ONE to-many
    // (users). waitListUsers is deliberately NOT joined here — joining two
    // to-many collections together would explode into a cartesian product.
    expect(scheduleRepo.find).toHaveBeenCalledTimes(1);
    const [, options] = scheduleRepo.find.mock.calls[0];
    expect(options.populate).toEqual(
      expect.arrayContaining(['users', 'admin'])
    );
    expect(options.populate).not.toContain('waitListUsers');
    expect(options.strategy).toBe(LoadStrategy.JOINED);

    // Round-trip 2: the remaining to-many collections loaded on their own via
    // select-in — including `allowedPlans`, which the per-caller planAccess
    // resolver reads on every schedule and would otherwise cause an N+1.
    expect(mockEntityManager.populate).toHaveBeenCalledTimes(1);
    const [, populateHint, populateOpts] =
      mockEntityManager.populate.mock.calls[0];
    expect(populateHint).toEqual(['waitListUsers', 'allowedPlans']);
    expect(populateOpts.strategy).toBe(LoadStrategy.SELECT_IN);
  });

  it('returns the schedules sorted by startDate ascending (contract unchanged)', async () => {
    const later = { id: 's2', startDate: '2026-01-02 10:00:00', admin: { id: 'a2' } };
    const earlier = { id: 's1', startDate: '2026-01-01 09:00:00', admin: { id: 'a1' } };
    scheduleRepo.find.mockResolvedValue([later, earlier]);

    const res: any = await scheduleService.getSchedulesRange(
      currentUser,
      new Date(),
      new Date()
    );

    expect(res.success).toBe(true);
    expect(res.schedules.map((s: any) => s.id)).toEqual(['s1', 's2']);
  });

  it('filters to the current user\'s own schedules when mySchedules is true', async () => {
    const mine = { id: 's1', startDate: '2026-01-01 09:00:00', admin: { id: 'u1' } };
    const others = { id: 's2', startDate: '2026-01-02 10:00:00', admin: { id: 'zzz' } };
    scheduleRepo.find.mockResolvedValue([mine, others]);

    const res: any = await scheduleService.getSchedulesRange(
      currentUser,
      new Date(),
      new Date(),
      true
    );

    expect(res.schedules.map((s: any) => s.id)).toEqual(['s1']);
  });

  it('throws when there is no authenticated user', async () => {
    await expect(
      scheduleService.getSchedulesRange(null as any, new Date(), new Date())
    ).rejects.toThrow();
  });
});
