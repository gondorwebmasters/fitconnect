import { IResolvers } from '@graphql-tools/utils';
import dotenv from 'dotenv';

import { Schedule } from '../../entities/Schedule';
import { ScheduleProgrammed } from '../../entities/ScheduleProgrammed';
import { Subscription } from '../../entities/Subscription';
import {
  createScheduleDataType,
  ScheduleService,
} from '../../services/schedule.service';
import {
  AddScheduleProps,
  ChangeScheduleStatusProp,
  ContextProps,
  GetMonthlyScheduleStats,
  DeleteScheduleProgrammedProps,
  GetScheduleProgrammedProps,
  GetScheduleProps,
  GetScheduleRangeProps,
  GetUserSchedulesProps,
  RemoveScheduleProps,
  RemoveUserSheduleProps,
  ScheduleDevelopmentProps,
  ScheduleProps,
  ScheduleResumeRange,
  ScheduleStatsProps,
  UpdateScheduleProgrammedProps,
  UpdateScheduleProps,
  updateScheduleOptionsProps,
} from '../../types/resolvers';
import { handleError } from '../../utils/errors.util';
import { schedulesPermissions } from '../../utils/permissions';
import { withPermissions } from '../middlewares/permissions';

dotenv.config();

// ===== FIELD RESOLVERS (Schedule) =====

/**
 * `Schedule.planAccess` es derivado **por llamante**, así que una lista de N
 * schedules restringidos resolvería N veces la misma suscripción. El `context`
 * vive exactamente lo que la petición: memorizamos ahí la promesa y todos los
 * schedules de esa petición comparten una sola consulta.
 *
 * @param context - Contexto de la petición GraphQL.
 * @param scheduleService - Servicio que sabe resolver la suscripción vigente.
 * @returns La suscripción vigente del llamante, o `null` si no tiene.
 */
const getLiveSubscription = (
  context: ContextProps,
  scheduleService: ScheduleService
): Promise<Subscription | null> => {
  context.liveSubscription ??= scheduleService.findLiveSubscription(
    context.currentUser
  );

  return context.liveSubscription;
};

/**
 * @returns Los planes que admite el schedule o la plantilla semanal; lista
 * vacía ⇒ sin restricción.
 */
const allowedPlans = async (
  restrictable: Schedule | ScheduleProgrammed,
  _: any,
  context: ContextProps
) => {
  const scheduleService = new ScheduleService(context.em);

  return await scheduleService.getAllowedPlans(restrictable);
};

/**
 * @returns Si el llamante puede inscribirse en lo que respecta a la
 * restricción de planes, el motivo si no, y los planes exigidos.
 */
const planAccess = async (
  schedule: Schedule,
  _: any,
  context: ContextProps
) => {
  const scheduleService = new ScheduleService(context.em);

  return await scheduleService.getSchedulePlanAccess(
    context.currentUser,
    schedule,
    () => getLiveSubscription(context, scheduleService)
  );
};

// ===== QUERY RESOLVERS =====

export const getSchedules = async (
  _: any,
  args: GetScheduleProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { scheduleId, schedulesIds } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getSchedules(
      currentUser,
      scheduleId,
      schedulesIds
    );
  } catch (error: any) {
    return handleError(error);
  }
};

const getUserSchedules = async (
  _: any,
  args: GetUserSchedulesProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { userId, past } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getUserSchedules(currentUser, userId, past);
  } catch (error: any) {
    return handleError(error);
  }
};

const getSchedulesFromToday = async (
  _: any,
  __: any,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getSchedulesFromToday(currentUser);
  } catch (error: any) {
    return handleError(error);
  }
};

const getSchedulesResume = async (_: any, __: any, context: ContextProps) => {
  try {
    const { em, currentUser } = context;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getSchedulesResume(currentUser);
  } catch (error: any) {
    return handleError(error);
  }
};

// const getAdminSchedules = async (
//   _: any,
//   __: IdProps,
//   context: ContextProps
// ) => {
//   try {
//     const { em, currentUser } = context;

//     const scheduleService = new ScheduleService(em);
//     return await scheduleService.getAdminSchedules(currentUser);
//   } catch (error: any) {
//     return handleError(error);
//   }
// };

const getTodaySchedulesResume = async (
  _: any,
  __: any,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getTodaySchedulesResume(currentUser);
  } catch (error: any) {
    return handleError(error);
  }
};

const getSchedulesRange = async (
  _: any,
  args: GetScheduleRangeProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { startDate, endDate, mySchedules } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getSchedulesRange(
      currentUser,
      startDate,
      endDate,
      mySchedules
    );
  } catch (error: any) {
    return handleError(error);
  }
};

const getSchedulesResumeRange = async (
  _: any,
  args: ScheduleResumeRange,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { startDate, endDate } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getSchedulesResumeRange(
      currentUser,
      startDate,
      endDate
    );
  } catch (error: any) {
    return handleError(error);
  }
};

const getScheduleOptions = async (_: any, __: any, context: ContextProps) => {
  try {
    const { em, currentUser } = context;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getScheduleOptions(currentUser);
  } catch (error: any) {
    return handleError(error);
  }
};

const getSchedulesStats = async (
  _: any,
  args: ScheduleStatsProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { month } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getSchedulesStats(currentUser, month);
  } catch (error: any) {
    return handleError(error);
  }
};

const getMonthlySchedules = async (
  _: any,
  args: GetMonthlyScheduleStats,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { month, startHour } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getMonthlySchedules(
      currentUser,
      month,
      startHour
    );
  } catch (error: any) {
    return handleError(error);
  }
};

const getSchedulesProgrammed = async (
  _: any,
  args: GetScheduleProgrammedProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { id } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.getSchedulesProgrammed(currentUser, id);
  } catch (error: any) {
    return handleError(error);
  }
};

// ===== MUTATION RESOLVERS =====

const createSchedule = async (
  _: any,
  args: ScheduleProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { schedule } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.createSchedule({
      ...schedule,
      currentUser,
    } as createScheduleDataType);
  } catch (error: any) {
    return handleError(error);
  }
};

const updateSchedule = async (
  _: any,
  args: UpdateScheduleProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { schedule } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.updateSchedule({
      ...schedule,
      currentUser,
    });
  } catch (error: any) {
    return handleError(error);
  }
};

const updateScheduleProgrammed = async (
  _: any,
  args: UpdateScheduleProgrammedProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { scheduleProgrammed } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.updateScheduleProgrammed({
      ...scheduleProgrammed,
      currentUser,
    });
  } catch (error: any) {
    return handleError(error);
  }
};

const deleteScheduleProgrammed = async (
  _: any,
  args: DeleteScheduleProgrammedProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { ids } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.deleteSchedulesProgrammed(currentUser, ids);
  } catch (error: any) {
    return handleError(error);
  }
};

const addUserToSchedule = async (
  _: any,
  args: AddScheduleProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { scheduleId } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.addUserToSchedule(currentUser, scheduleId);
  } catch (error: any) {
    return handleError(error);
  }
};

const removeUserFromSchedule = async (
  _: any,
  args: RemoveUserSheduleProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { scheduleId, userId } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.removeUserFromSchedule(
      currentUser,
      scheduleId,
      userId
    );
  } catch (error: any) {
    return handleError(error);
  }
};

const createScheduleDevelopment = async (
  _: any,
  args: ScheduleDevelopmentProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { scheduleDevelopment } = args;
    const { title, startTime, endTime, maxUsers, state } = scheduleDevelopment;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.createScheduleDevelopment(
      currentUser,
      title,
      startTime,
      endTime,
      maxUsers,
      state
    );
  } catch (error: any) {
    return handleError(error);
  }
};

const changeScheduleStatus = async (
  _: any,
  args: ChangeScheduleStatusProp,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { scheduleId, status, reason } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.changeScheduleStatus(
      currentUser,
      scheduleId,
      status,
      reason
    );
  } catch (error: any) {
    return handleError(error);
  }
};

const removeSchedule = async (
  _: any,
  args: RemoveScheduleProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { scheduleId } = args;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.removeSchedule(currentUser, scheduleId);
  } catch (error: any) {
    return handleError(error);
  }
};

const updateScheduleOptions = async (
  _: any,
  args: updateScheduleOptionsProps,
  context: ContextProps
) => {
  try {
    const { em, currentUser } = context;
    const { scheduleOptions } = args;
    const {
      maxActiveReservations,
      maxAdvanceBookingDays,
      sameDayBookingAllowed,
      fullOpenHours,
      bookingCutoffMinutes,
      minBookingsRequired,
      quotaWarningThresholds,
    } = scheduleOptions;

    const scheduleService = new ScheduleService(em);
    return await scheduleService.updateScheduleOptions(
      currentUser,
      maxActiveReservations,
      maxAdvanceBookingDays,
      sameDayBookingAllowed,
      fullOpenHours,
      bookingCutoffMinutes,
      minBookingsRequired,
      quotaWarningThresholds
    );
  } catch (error: any) {
    return handleError(error);
  }
};

export const scheduleResolvers: IResolvers = {
  Query: {
    getSchedules,
    getSchedulesFromToday: withPermissions(
      schedulesPermissions.READ,
      getSchedulesFromToday
    ),
    getSchedulesResume: withPermissions(
      schedulesPermissions.READ,
      getSchedulesResume
    ),
    getTodaySchedulesResume: withPermissions(
      schedulesPermissions.READ,
      getTodaySchedulesResume
    ),
    getSchedulesRange,
    getSchedulesResumeRange,
    getScheduleOptions: getScheduleOptions,
    getSchedulesStats: withPermissions(
      schedulesPermissions.READ,
      getSchedulesStats
    ),
    getMonthlySchedules: withPermissions(
      schedulesPermissions.READ,
      getMonthlySchedules
    ),
    getUserSchedules,
    getSchedulesProgrammed: withPermissions(
      schedulesPermissions.READ,
      getSchedulesProgrammed
    ),
  },
  Schedule: {
    allowedPlans,
    planAccess,
  },
  ScheduleProgrammed: {
    allowedPlans,
  },
  Mutation: {
    createSchedule: withPermissions(
      schedulesPermissions.CREATE,
      createSchedule
    ),
    updateSchedule: withPermissions(
      schedulesPermissions.UPDATE,
      updateSchedule
    ),
    updateScheduleProgrammed: withPermissions(
      schedulesPermissions.UPDATE,
      updateScheduleProgrammed
    ),
    deleteScheduleProgrammed: withPermissions(
      schedulesPermissions.DELETE,
      deleteScheduleProgrammed
    ),
    addUserToSchedule: withPermissions(
      schedulesPermissions.READ,
      addUserToSchedule
    ),
    removeUserFromSchedule: withPermissions(
      schedulesPermissions.READ,
      removeUserFromSchedule
    ),
    createScheduleDevelopment: withPermissions(
      schedulesPermissions.CREATE,
      createScheduleDevelopment
    ),
    changeScheduleStatus: withPermissions(
      schedulesPermissions.UPDATE,
      changeScheduleStatus
    ),
    removeSchedule: withPermissions(
      schedulesPermissions.DELETE,
      removeSchedule
    ),
    updateScheduleOptions: withPermissions(
      schedulesPermissions.UPDATE,
      updateScheduleOptions
    ),
  },
};
