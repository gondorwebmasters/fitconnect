import { EntityManager } from '@mikro-orm/core';
import moment, { Moment } from 'moment';

import { Plan } from '../entities/Plan';
import { Schedule } from '../entities/Schedule';
import { ScheduleProgrammed } from '../entities/ScheduleProgrammed';
import { User } from '../entities/User';
import { NotificationService } from '../services/notification.service';
import { CurrentUser } from '../types/common.type';
import { ScheduleState, ScheduleType, UserRoleEnum } from '../types/enums';

import {
  ForbiddenError,
  InternalServerError,
  UnauthorizedError,
} from './errors.util';

/**
 * Crear fecha con tiempo específico
 */
export function createDateWithTime(time: string): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/**
 * Crear schedule programado con validaciones y manejo de errores.
 *
 * @param data - Datos de la plantilla semanal. `allowedPlans` es su
 * restricción de planes (**Restricted Schedule**); vacío ⇒ plantilla abierta.
 * @param context - `em` en el que crearla y usuario que la crea.
 * @returns La plantilla creada, ya con sus primeros schedules engendrados.
 * @throws UnauthorizedError | ForbiddenError si el usuario no puede crearla.
 */
export const createScheduleProgrammed = async (
  {
    daysOfWeek = [],
    startHour,
    endHour,
    maxUsers,
    title,
    description,
    admin,
    age,
    type,
    allowedPlans = [],
  }: {
    daysOfWeek: number[];
    startHour: string;
    endHour: string;
    maxUsers: number;
    title: string;
    description: string;
    admin: User;
    age: number | null;
    type: ScheduleType;
    /** Restricted Schedule: planes que admite la plantilla. Vacío ⇒ abierta. */
    allowedPlans?: Plan[];
  },
  { em, currentUser }: { em: EntityManager; currentUser: CurrentUser }
): Promise<ScheduleProgrammed> => {
  if (!currentUser) {
    throw new UnauthorizedError();
  }

  if (currentUser.contextRole === UserRoleEnum.STANDARD) {
    throw new ForbiddenError("You don't have permission to create schedules");
  }

  try {
    const newScheduleProgrammed = em.create<ScheduleProgrammed>(
      ScheduleProgrammed,
      {
        daysOfWeek,
        startHour,
        endHour,
        maxUsers,
        admin,
        title,
        age,
        type,
        description,
        company: currentUser.activeCompanyId!,
      }
    );

    if (allowedPlans.length) {
      newScheduleProgrammed.allowedPlans.set(allowedPlans);
    }

    em.persist(newScheduleProgrammed);
    await em.flush();

    // Crear schedules iniciales
    await createInitialSchedules(newScheduleProgrammed, em);

    return newScheduleProgrammed;
  } catch (error: any) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      throw error;
    }
    console.error('Error creating schedule:', error);
    throw new InternalServerError('Error creating schedule');
  }
};

/**
 * Crear schedules iniciales para los próximos días programados
 */
export const createInitialSchedules = async (
  scheduleProgrammed: ScheduleProgrammed,
  em: EntityManager,
  specificDays?: number[]
): Promise<void> => {
  const now = moment();

  const [startHour, startMinutes] = scheduleProgrammed.startHour
    .split(':')
    .map(Number);

  const daysToCreate = specificDays || scheduleProgrammed.daysOfWeek;

  const promises = daysToCreate.map(async day => {
    // Crear horarios para los dos días futuros más cercanos
    let createdCount = 0;
    let i = 0;

    while (createdCount < 2 && i < 4) {
      const targetDay = now
        .clone()
        .day(day)
        .add(i * 7, 'days');

      targetDay.set({
        hour: startHour,
        minute: startMinutes,
        second: 0,
        millisecond: 0,
      });

      if (targetDay.isAfter(now)) {
        await createScheduleInXWeeks(targetDay, day, 0, scheduleProgrammed, em);
        createdCount++;
      }
      i++;
    }
  });

  await Promise.all(promises);
};

/**
 * Planes que admite un schedule o una plantilla semanal (**Restricted
 * Schedule**), inicializando la colección si hace falta. Vive aquí, en la capa
 * baja, para que la plantilla y el schedule lean su restricción por el mismo
 * sitio; `ScheduleService.getAllowedPlans` delega en ella.
 *
 * @param restrictable - Schedule o plantilla semanal.
 * @returns Los planes admitidos; lista vacía ⇒ sin restricción.
 */
export const getAllowedPlansOf = async (
  restrictable: Schedule | ScheduleProgrammed
): Promise<Plan[]> => {
  if (!restrictable.allowedPlans) {
    return [];
  }
  if (!restrictable.allowedPlans.isInitialized()) {
    await restrictable.allowedPlans.init();
  }
  return restrictable.allowedPlans.getItems();
};

/**
 * Crear schedule en X semanas a partir de una fecha, sembrando en él la
 * restricción de planes de su plantilla.
 *
 * @param now - Fecha desde la que se cuenta.
 * @param day - Día de la semana (0 = domingo) del schedule a crear.
 * @param weeksFromNow - Semanas a sumar; 0 es la semana en curso.
 * @param scheduleProgrammed - Plantilla que lo engendra.
 * @param em - EntityManager en el que crearlo.
 * @returns `true` si lo ha creado, `false` si ya existía o la plantilla no
 * tiene admin.
 */
export const createScheduleInXWeeks = async (
  now: Moment,
  day: number,
  weeksFromNow: number,
  scheduleProgrammed: ScheduleProgrammed,
  em: EntityManager
): Promise<boolean> => {
  if (!scheduleProgrammed.admin) {
    console.warn(
      `[createScheduleInXWeeks] scheduleProgrammed sin admin (ID: ${scheduleProgrammed.id}, Title: "${scheduleProgrammed.title}")`
    );
    return false;
  }

  const daysToAdd = ((7 + day - now.day()) % 7) + weeksFromNow * 7;
  const startDate = now.clone().add(daysToAdd, 'days');
  const endDate = now.clone().add(daysToAdd, 'days');

  const [startHour, startMinutes] = scheduleProgrammed.startHour
    .split(':')
    .map(Number);
  const [endHour, endMinutes] = scheduleProgrammed.endHour
    .split(':')
    .map(Number);

  // Ajustar la hora en la fecha objetivo
  startDate.set({
    hour: startHour,
    minute: startMinutes,
    second: 0,
    millisecond: 0,
  });
  endDate.set({
    hour: endHour,
    minute: endMinutes,
    second: 0,
    millisecond: 0,
  });

  const existingSchedule = await em.findOne(
    Schedule,
    {
      startDate: startDate.toDate(),
      scheduleProgrammed,
    },
    { filters: false }
  );

  if (existingSchedule) {
    return false;
  }

  const newSchedule = em.create<Schedule>(Schedule, {
    startDate: startDate.toDate(),
    endDate: endDate.toDate(),
    maxUsers: scheduleProgrammed.maxUsers,
    state: ScheduleState.AVAILABLE,
    admin: scheduleProgrammed.admin,
    title: scheduleProgrammed.title,
    description: scheduleProgrammed.description,
    type: scheduleProgrammed.type,
    age: scheduleProgrammed.age,
    scheduleProgrammed,
    company: scheduleProgrammed.company,
  });

  // Restricted Schedule: el schedule nace con la restricción de su plantilla
  // (issue #12). Plantilla sin restricción ⇒ schedule abierto, como siempre.
  const allowedPlans = await getAllowedPlansOf(scheduleProgrammed);
  if (allowedPlans.length) {
    newSchedule.allowedPlans.set(allowedPlans);
  }

  em.persist(newSchedule);
  return true;
};

/**
 * Enviar recordatorios de schedules próximos (2-3 horas antes)
 * Esta función se ejecuta por cron job
 */
export const sendScheduleReminders = async (
  em: EntityManager
): Promise<{ schedulesProcessed: number; notificationsSent: number }> => {
  console.log('🚀 Checking for upcoming schedules to send reminders...');

  const now = moment();
  const twoHoursFromNow = now.clone().add(2, 'hours');
  const threeHoursFromNow = twoHoursFromNow.clone().add(1, 'hour');

  let notificationsSent = 0;
  let schedulesProcessed = 0;

  try {
    const scheduleRepo = em.getRepository(Schedule);
    const upcomingSchedules = await scheduleRepo.find(
      {
        startDate: {
          $gte: twoHoursFromNow.toDate(),
          $lt: threeHoursFromNow.toDate(),
        },
        state: ScheduleState.AVAILABLE,
      },
      { populate: ['users', 'users.pushTokens'], filters: false }
    );

    schedulesProcessed = upcomingSchedules.length;

    if (schedulesProcessed === 0) {
      console.log('No upcoming schedules found.');
      return { schedulesProcessed: 0, notificationsSent: 0 };
    }

    console.log(`Found ${schedulesProcessed} upcoming schedules.`);

    for (const schedule of upcomingSchedules) {
      const sent = await sendScheduleReminderNotifications(schedule, em);
      notificationsSent += sent;
    }

    console.log('✅ Finished sending schedule reminders.');
  } catch (error) {
    console.error('Error sending schedule reminders:', error);
    // No lanzar error - es un cron job, solo loguear
  }

  return { schedulesProcessed, notificationsSent };
};

const sendScheduleReminderNotifications = async (
  schedule: Schedule,
  em: EntityManager
): Promise<number> => {
  let notificationsSent = 0;
  try {
    const title = '¡Tu clase está a punto de empezar!';
    const body = `Tu clase de "${schedule.title}" empieza a las ${moment(
      schedule.startDate
    ).format('HH:mm')}.`;
    const data = {
      type: 'schedule_reminder',
      scheduleId: schedule.id,
    };

    const users = schedule.users.getItems();

    if (users.length === 0) {
      console.log(`Schedule ${schedule.id} has no users enrolled.`);
      return 0;
    }

    const notificationService = new NotificationService(em);
    const userIds = users.map(user => user.id);
    await notificationService.sendToUsers(
      userIds,
      title,
      body,
      data,
      schedule.company?.id
    );

    console.log(
      `Sent ${notificationsSent} reminder notifications for schedule ${schedule.id}`
    );
  } catch (error) {
    console.error(
      `Error sending notifications for schedule ${schedule.id}:`,
      error
    );
    // No lanzar error - continuar con el siguiente schedule
  }
  return notificationsSent;
};
