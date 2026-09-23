import { EntityManager, LoadStrategy, raw } from '@mikro-orm/core';
import { SqlEntityManager } from '@mikro-orm/postgresql';
import moment from 'moment';

import { Company } from '../entities/Company';
import { Plan } from '../entities/Plan';
import { Schedule } from '../entities/Schedule';
import { ScheduleOptions } from '../entities/ScheduleOptions';
import { ScheduleProgrammed } from '../entities/ScheduleProgrammed';
import { Subscription } from '../entities/Subscription';
import { User } from '../entities/User';
import { CurrentUser, ServiceResponse } from '../types/common.type';
import {
  SchedulePlanAccessReason,
  ScheduleState,
  ScheduleType,
  UserRoleEnum,
} from '../types/enums';
import { UpdateScheduleProgrammedProps } from '../types/resolvers';
import {
  createServiceResponse,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  VAL_ERRORS,
  NOT_FND_ERRORS,
  FORBIDDEN_ERRORS,
} from '../utils/errors.util';
import {
  createDateWithTime,
  createInitialSchedules,
  createScheduleProgrammed,
  getAllowedPlansOf,
} from '../utils/schedules.util';

import { BaseService } from './base.service';
import { NotificationService } from './notification.service';
import { PermissionService } from './permission.service';

export type createScheduleDataType = {
  currentUser: CurrentUser;
  title: string;
  description: string;
  startHour: string;
  endHour: string;
  days: number[];
  maxUsers: number;
  age: number | null | undefined;
  admin: string;
  type: ScheduleType;
  repeat: boolean;
  date?: string;
  allowedPlanIds?: string[];
};

export type updateScheduleDataType = {
  currentUser: CurrentUser;
  id: string;
  title?: string;
  description?: string;
  maxUsers?: number;
  age?: number | null;
  admin?: string;
  type?: ScheduleType;
  state?: ScheduleState;
  date?: string;
  startHour?: string;
  endHour?: string;
  allowedPlanIds?: string[];
};

/**
 * Resultado del gate de **Restricted Schedule** para un llamante concreto.
 * Cubre solo la restricción de planes: ni aforo, ni créditos, ni ventana de
 * reserva anticipada. Ver ADR 0005.
 */
export type SchedulePlanAccess = {
  canRegister: boolean;
  reason: SchedulePlanAccessReason | null;
  requiredPlans: Plan[];
};

export class ScheduleService extends BaseService {
  constructor(em: EntityManager) {
    super(em);
  }

  /**
   * Obtener schedules por ID, IDs múltiples o todos
   */
  public async getSchedules(
    currentUser: CurrentUser,
    scheduleId?: string,
    schedulesIds?: string[]
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    const scheduleRepo = this.em.getRepository(Schedule);

    // Por ID único
    if (scheduleId) {
      const schedule = await scheduleRepo.findOne(
        { id: scheduleId },
        { populate: ['admin', 'users', 'waitListUsers', 'allowedPlans'] }
      );

      if (!schedule) {
        throw new NotFoundError('Schedule');
      }

      return createServiceResponse(200, 'Schedule found', true, { schedule });
    }

    // Por IDs múltiples
    if (schedulesIds) {
      if (schedulesIds.length === 0) {
        return createServiceResponse(200, 'Schedules not found', true, {
          schedules: [],
        });
      }

      const schedules = await scheduleRepo.find(
        { id: { $in: schedulesIds } },
        { populate: ['admin', 'users', 'waitListUsers', 'allowedPlans'] }
      );

      if (!schedules || schedules.length === 0) {
        throw new NotFoundError('Schedules');
      }

      return createServiceResponse(200, 'Schedules found', true, { schedules });
    }

    // Todos los schedules
    const schedules = await scheduleRepo.findAll({
      populate: ['admin', 'users', 'waitListUsers', 'allowedPlans'],
    });

    return createServiceResponse(200, 'Schedules found', true, { schedules });
  }

  public async getUserSchedules(
    currentUser: CurrentUser,
    userId?: string,
    past: boolean = false
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    const targetUserId = userId || currentUser.id;

    // Solo ADMIN puede ver schedules de otros usuarios, o COACH si tiene permisos
    if (
      targetUserId !== currentUser.id &&
      currentUser.contextRole === UserRoleEnum.STANDARD
    ) {
      throw new ForbiddenError(
        'You are not authorized to view these schedules'
      );
    }

    const scheduleRepo = this.em.getRepository(Schedule);
    const filter: any = {
      $or: [{ users: targetUserId }, { waitListUsers: targetUserId }],
    };

    if (!past) {
      filter.startDate = { $gte: new Date() };
    }

    const schedules = await scheduleRepo.find(filter, {
      populate: ['admin', 'users', 'waitListUsers', 'allowedPlans'],
      orderBy: { startDate: 'ASC' },
    });

    return createServiceResponse(200, 'User schedules found', true, {
      schedules,
    });
  }

  /**
   * Obtener schedules desde hoy en adelante
   */
  public async getSchedulesFromToday(
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    const scheduleRepo = this.em.getRepository(Schedule);
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));

    const schedules = await scheduleRepo.find(
      {
        startDate: { $gte: startOfDay },
      },
      { populate: ['users'] }
    );

    return createServiceResponse(200, 'Schedules found', true, { schedules });
  }

  /**
   * Obtener resumen de schedules desde hoy
   */
  public async getSchedulesResume(
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    try {
      const scheduleRepo = this.em.getRepository(Schedule);
      const today = new Date();
      const startOfDay = new Date(today.setHours(0, 0, 0, 0));

      const schedules = await scheduleRepo.find(
        {
          startDate: { $gte: startOfDay },
        },
        { populate: ['users'], orderBy: { startDate: 'ASC' } }
      );

      const schedulesResume = schedules.map(schedule => ({
        id: schedule.id,
        startDate: schedule.startDate,
        maxUsers: schedule.maxUsers,
        state: schedule.state,
        ocupancy: schedule.users.length,
      }));

      return createServiceResponse(200, 'Schedules found', true, {
        schedulesResume,
      });
    } catch (error: any) {
      throw new InternalServerError(
        `Error fetching schedules resume ${error.message}`
      );
    }
  }

  /**
   * Obtener schedules de admin (solo COACH/ADMIN)
   */
  public async getAdminSchedules(
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole === UserRoleEnum.STANDARD) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    const userRepo = this.em.getRepository(User);
    const user = await userRepo.findOne(
      { id: currentUser.id },
      { populate: ['adminSchedules'] }
    );

    if (!user) {
      throw new NotFoundError('User');
    }

    return createServiceResponse(
      200,
      'Admin schedules fetched successfully',
      true,
      {
        schedules: user.adminSchedules.getItems(),
      }
    );
  }

  /**
   * Obtener resumen de schedules de hoy
   */
  public async getTodaySchedulesResume(
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    try {
      const scheduleRepo = this.em.getRepository(Schedule);
      const today = new Date();
      const startOfDay = new Date(today.setHours(0, 0, 0, 0));
      const endOfDay = new Date(today.setHours(23, 59, 59, 999));

      const todaySchedules = await scheduleRepo.find(
        {
          startDate: { $gte: startOfDay, $lte: endOfDay },
        },
        { populate: ['users'] }
      );

      const schedulesResume = todaySchedules.map(schedule => ({
        id: schedule.id,
        startDate: schedule.startDate,
        maxUsers: schedule.maxUsers,
        state: schedule.state,
        ocupancy: schedule.users.length,
      }));

      return createServiceResponse(200, 'Schedules found', true, {
        schedulesResume,
      });
    } catch (error: any) {
      throw new InternalServerError(
        `Error fetching today schedules resume ${error.message}`
      );
    }
  }

  /**
   * Obtener schedules en rango de fechas
   */
  public async getSchedulesRange(
    currentUser: CurrentUser,
    startDate: Date | string,
    endDate: Date | string,
    mySchedules?: boolean
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    try {
      const scheduleRepo = this.em.getRepository(Schedule);
      const startOfDay = moment(startDate).format('YYYY/MM/DD HH:mm:ss');
      const endOfDay = moment(endDate).format('YYYY/MM/DD HH:mm:ss');

      // Resolver limitado por latencia (Supabase remoto): el coste es
      // nº de round-trips × latencia, no el volumen. La estrategia por defecto
      // (select-in) hace una query por relación → ~4 viajes. Colapsamos a 2 sin
      // arriesgar un producto cartesiano:
      //   1) find con JOINED de `admin` (to-one, gratis) + `users` (UNA to-many:
      //      un solo LEFT JOIN, sin multiplicar filas) → 1 query.
      //   2) `waitListUsers` (la SEGUNDA to-many) se puebla aparte por select-in.
      // Juntar users×waitListUsers en el mismo JOIN sí explotaría en cartesiano;
      // separarlas mantiene el coste constante tanto con pocos como con muchos
      // apuntados. Seguimos usando find(), así que el filtro companyContext se
      // aplica solo (imposible olvidarlo) y el contrato GraphQL no cambia.
      const schedules = await scheduleRepo.find(
        {
          startDate: { $gte: startOfDay, $lte: endOfDay },
        },
        { populate: ['users', 'admin'], strategy: LoadStrategy.JOINED }
      );

      // `allowedPlans` viaja en el mismo select-in: es una tercera to-many y
      // el resolver por llamante de `planAccess` la mira en cada schedule, así
      // que traerla en bloque evita un N+1 en la vista de calendario.
      await this.em.populate(schedules, ['waitListUsers', 'allowedPlans'], {
        strategy: LoadStrategy.SELECT_IN,
      });

      const sortSchedules = [...schedules].sort((a, b) => {
        return moment(a.startDate).unix() - moment(b.startDate).unix();
      });

      if (mySchedules) {
        const myUser = this.em.getReference(User, currentUser.id);
        const mySchedulesFiltered = sortSchedules.filter(
          schedule => schedule.admin.id === myUser.id
        );

        return createServiceResponse(200, 'Schedules found', true, {
          schedules: mySchedulesFiltered,
        });
      }

      return createServiceResponse(200, 'Schedules found', true, {
        schedules: sortSchedules,
      });
    } catch (error: any) {
      throw new InternalServerError(
        `Error fetching schedules range ${error.message}`
      );
    }
  }

  /**
   * Obtener resumen de schedules en rango de fechas
   */
  public async getSchedulesResumeRange(
    currentUser: CurrentUser,
    startDate: Date | string,
    endDate: Date | string
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    try {
      const startOfDay = new Date(startDate);
      const endOfDay = new Date(endDate);

      // Resolver limitado por latencia: contra un Postgres remoto (Supabase) el
      // coste del resolver es (nº de queries × latencia de red), no el volumen de
      // datos. Por eso resolvemos los schedules y su ocupación en UN solo
      // round-trip: un LEFT JOIN a la M:N + COUNT agrupado, en vez de hidratar la
      // colección `users` (y `admin`, que aquí no se usa). Lo lanzamos en paralelo
      // con las opciones de la compañía.
      //
      // Usamos el QueryBuilder de MikroORM (relaciones por nombre: `s.users`) en
      // vez de SQL en crudo. OJO: en v6 el QueryBuilder NO aplica solo los @Filter
      // de la entidad; hay que llamar a `applyFilters()` explícitamente. Eso añade
      // el scoping de `companyContext` reutilizando la definición del filtro (con
      // el companyId que fija el middleware por request), sin hardcodear company_id.
      type ScheduleResumeRow = {
        id: string;
        startDate: Date;
        maxUsers: number;
        state: string;
        ocupancy: number | string;
      };

      // `createQueryBuilder` sólo existe en el EM de SQL; en runtime el driver es
      // postgres, así que el cast es seguro (mismo patrón que report.service.ts).
      const qb = (this.em as SqlEntityManager)
        .createQueryBuilder(Schedule, 's')
        .select(['s.id', 's.startDate', 's.maxUsers', 's.state'])
        .addSelect(raw('count(u.id) as ocupancy'))
        .leftJoin('s.users', 'u')
        .where({ startDate: { $gte: startOfDay, $lte: endOfDay } })
        .groupBy('s.id')
        .orderBy({ startDate: 'asc' });

      await qb.applyFilters();

      const [company, rows] = await Promise.all([
        this.em.findOne(
          Company,
          { id: { $ne: null } },
          { populate: ['scheduleOptions'] }
        ),
        qb.execute<ScheduleResumeRow[]>(),
      ]);

      const scheduleOptions = company?.scheduleOptions || null;

      const schedulesResume = rows.map((row: ScheduleResumeRow) => ({
        id: row.id,
        startDate: row.startDate,
        maxUsers: row.maxUsers,
        state: row.state as ScheduleState,
        // COUNT vuelve como bigint (string en node-postgres); normalizamos a number.
        ocupancy: Number(row.ocupancy),
      }));

      return createServiceResponse(200, 'Schedules found', true, {
        schedulesResume,
        scheduleOptions,
      });
    } catch (error: any) {
      throw new InternalServerError(
        `Error fetching schedules resume range ${error.message}`
      );
    }
  }

  /**
   * Obtener opciones de schedule
   */
  public async getScheduleOptions(
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    try {
      const scheduleOptionRepo = this.em.getRepository(ScheduleOptions);
      const scheduleOptions = await scheduleOptionRepo.findOne({
        company: currentUser.activeCompanyId,
      });

      return createServiceResponse(200, 'Schedule options found', true, {
        scheduleOptions,
      });
    } catch (error: any) {
      throw new InternalServerError(
        `Error fetching schedule options ${error.message}`
      );
    }
  }

  /**
   * Obtener estadísticas de schedules (solo ADMIN)
   */
  public async getSchedulesStats(
    currentUser: CurrentUser,
    month: number
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole !== UserRoleEnum.ADMIN) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    try {
      const ScheduleRepo = this.em.getRepository(Schedule);

      // Rangos de fechas
      const startOfMonth = moment().month(month).startOf('month').toDate();
      const endOfMonth = moment().month(month).endOf('month').toDate();

      const startPastMonth = moment()
        .month(month - 1)
        .startOf('month')
        .toDate();
      const endPastMonth = moment()
        .month(month - 1)
        .endOf('month')
        .toDate();

      // Consultas concurrentes en paralelo con selección optimizada de fields (solo users.id)
      const [schedulesFirstMonth, schedulesPastMonth] = await Promise.all([
        ScheduleRepo.find(
          { startDate: { $gte: startOfMonth, $lte: endOfMonth } },
          { fields: ['maxUsers', 'startDate', 'users.id'] }
        ),
        ScheduleRepo.find(
          { startDate: { $gte: startPastMonth, $lte: endPastMonth } },
          { fields: ['maxUsers', 'startDate', 'users.id'] }
        ),
      ]);

      // Helper para procesar las estadísticas de forma lineal O(N) sin duplicar lógica
      const processStats = (schedules: typeof schedulesFirstMonth) => {
        const grouped = new Map<
          string,
          { totalRatio: number; count: number }
        >();

        for (const schedule of schedules) {
          const dayAndTime = moment(schedule.startDate).format('ddd HH:mm');
          const ratio = schedule.users.length / schedule.maxUsers;

          const existing = grouped.get(dayAndTime);
          if (existing) {
            existing.totalRatio += ratio;
            existing.count += 1;
          } else {
            grouped.set(dayAndTime, { totalRatio: ratio, count: 1 });
          }
        }

        const summary = [];
        for (const [dayAndTime, data] of grouped) {
          summary.push({
            dayAndTime,
            ratio: (data.totalRatio / data.count) * 100,
          });
        }
        return summary;
      };

      return createServiceResponse(200, 'Schedules found', true, {
        stats: [
          processStats(schedulesFirstMonth),
          processStats(schedulesPastMonth),
        ],
      });
    } catch (error: any) {
      if (
        error instanceof ForbiddenError ||
        error instanceof UnauthorizedError
      ) {
        throw error;
      }
      throw new InternalServerError('Error fetching schedules stats');
    }
  }

  /**
   * Obtener schedules mensuales por hora específica (solo ADMIN)
   */
  public async getMonthlySchedules(
    currentUser: CurrentUser,
    month: number,
    startHour: string
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole !== UserRoleEnum.ADMIN) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    const startOfMonth = moment().month(month).startOf('month').toDate();
    const endOfMonth = moment().month(month).endOf('month').toDate();

    const monthlySchedules = await this.em.find(
      Schedule,
      {
        startDate: { $gte: startOfMonth, $lte: endOfMonth },
      },
      { populate: ['users'] }
    );

    const matchHourSchedules = monthlySchedules.filter(schedule => {
      return (
        moment(Number(schedule.startDate)).format('ddd HH:mm') === startHour
      );
    });

    if (matchHourSchedules.length > 0) {
      return createServiceResponse(200, 'Schedules found', true, {
        schedules: matchHourSchedules,
      });
    } else {
      throw new NotFoundError('Schedules');
    }
  }

  public async createSchedule(
    scheduleData: createScheduleDataType
  ): Promise<ServiceResponse> {
    const {
      currentUser,
      age,
      repeat,
      days,
      title,
      description,
      startHour,
      endHour,
      maxUsers,
      type,
      admin,
      date,
      allowedPlanIds,
    } = scheduleData;
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole === UserRoleEnum.STANDARD) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    return await this.em.transactional(async tem => {
      try {
        const finalAge = age && age > 0 ? age : null;
        const adminRef = tem.getReference(User, admin);

        if (repeat) {
          // La plantilla semanal lleva la restricción y la siembra en cada
          // schedule que engendra (issue #12), en vez de obligar al
          // administrador a re-marcarlos uno a uno cada semana.
          await createScheduleProgrammed(
            {
              daysOfWeek: days,
              title,
              description,
              startHour,
              endHour,
              maxUsers,
              admin: adminRef,
              age: finalAge,
              type,
              allowedPlans: await this.resolveAllowedPlans(
                tem,
                allowedPlanIds ?? []
              ),
            },
            { em: tem, currentUser }
          );

          return createServiceResponse(200, 'Schedule created', true);
        } else {
          if (!date) {
            throw new ValidationError(
              'Date is required for non-repeating schedules'
            );
          }

          const schedules: Schedule[] = [];
          const [startH, startM] = startHour.split(':').map(Number);
          const [endH, endM] = endHour.split(':').map(Number);

          const startDate = moment(date).set({
            hour: startH,
            minute: startM,
            second: 0,
            millisecond: 0,
          });

          const endDate = startDate.clone().set({
            hour: endH,
            minute: endM,
          });

          const newSchedule = tem.create(Schedule, {
            title,
            description,
            age: finalAge,
            type,
            startDate: startDate.toDate(),
            endDate: endDate.toDate(),
            maxUsers,
            state: ScheduleState.AVAILABLE,
            admin: adminRef,
            company: currentUser.activeCompanyId!,
          });

          // Restricted Schedule: lista vacía u omitida ⇒ schedule abierto, que
          // es como nace cualquier schedule que no diga lo contrario.
          if (allowedPlanIds?.length) {
            newSchedule.allowedPlans.set(
              await this.resolveAllowedPlans(tem, allowedPlanIds)
            );
          }

          tem.persist(newSchedule);
          schedules.push(newSchedule);

          await tem.flush();

          return createServiceResponse(
            200,
            'Schedule created successfully',
            true,
            {
              schedules,
            }
          );
        }
      } catch (error: any) {
        if (
          error instanceof ForbiddenError ||
          error instanceof UnauthorizedError ||
          error instanceof ValidationError
        ) {
          throw error;
        }
        throw new InternalServerError('Error creating schedule');
      }
    });
  }

  /**
   * Obtener schedules programados
   */
  public async getSchedulesProgrammed(
    currentUser: CurrentUser,
    id?: string
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole === UserRoleEnum.STANDARD) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    const scheduleProgrammedRepo = this.em.getRepository(ScheduleProgrammed);

    if (id) {
      const scheduleProgrammed = await scheduleProgrammedRepo.findOne(
        { id },
        { populate: ['admin', 'allowedPlans'] }
      );
      if (!scheduleProgrammed) {
        throw new NotFoundError('ScheduleProgrammed');
      }
      return createServiceResponse(200, 'Schedule programmed found', true, {
        scheduleProgrammed,
      });
    }

    const schedulesProgrammed = await scheduleProgrammedRepo.findAll({
      populate: ['admin', 'allowedPlans'],
    });
    return createServiceResponse(200, 'Schedules programmed found', true, {
      schedulesProgrammed,
    });
  }

  /**
   * Eliminar schedules programados
   */
  public async deleteSchedulesProgrammed(
    currentUser: CurrentUser,
    ids: string[]
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole === UserRoleEnum.STANDARD) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    return await this.em.transactional(async tem => {
      const scheduleProgrammedRepo = tem.getRepository(ScheduleProgrammed);
      const now = new Date();

      for (const id of ids) {
        const scheduleProgrammed = await scheduleProgrammedRepo.findOne(
          { id },
          {
            populate: [
              'schedules',
              'schedules.users',
              'schedules.waitListUsers',
            ],
          }
        );

        if (!scheduleProgrammed) {
          continue; // O podrías lanzar error, pero en lote suele ser mejor continuar si no existe
        }

        // Separar horarios pasados y futuros
        const schedules = scheduleProgrammed.schedules.getItems();
        const futureSchedules = schedules.filter(s => s.startDate > now);
        const pastSchedules = schedules.filter(s => s.startDate <= now);

        // Procesar horarios futuros
        for (const futureSchedule of futureSchedules) {
          const hasUsers =
            futureSchedule.users.length > 0 ||
            futureSchedule.waitListUsers.length > 0;

          if (hasUsers) {
            if (futureSchedule.state !== ScheduleState.CANCELLED) {
              await this.changeScheduleStatus(
                currentUser,
                futureSchedule.id,
                ScheduleState.CANCELLED,
                'Cambio en la programación semanal',
                tem
              );
            }
            futureSchedule.scheduleProgrammed = undefined;
          } else {
            scheduleProgrammed.schedules.remove(futureSchedule);
            tem.remove(futureSchedule);
          }
        }

        // Desvincular horarios pasados
        for (const pastSchedule of pastSchedules) {
          pastSchedule.scheduleProgrammed = undefined;
        }

        // Eliminar el schedule programado
        tem.remove(scheduleProgrammed);
      }

      await tem.flush();

      return createServiceResponse(
        200,
        'Schedules programmed deleted successfully',
        true
      );
    });
  }

  /**
   * Actualizar schedule programado
   */
  public async updateScheduleProgrammed(
    data: UpdateScheduleProgrammedProps['scheduleProgrammed'] & {
      currentUser: CurrentUser;
    }
  ): Promise<ServiceResponse> {
    const { currentUser, id, ...updateData } = data;

    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole === UserRoleEnum.STANDARD) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    return await this.em.transactional(async tem => {
      const scheduleProgrammedRepo = tem.getRepository(ScheduleProgrammed);
      const scheduleProgrammed = await scheduleProgrammedRepo.findOne(
        { id },
        {
          populate: [
            'schedules',
            'schedules.users',
            'schedules.waitListUsers',
            'schedules.allowedPlans',
            'admin',
            'company',
            'allowedPlans',
          ],
        }
      );

      if (!scheduleProgrammed) {
        throw new NotFoundError('ScheduleProgrammed');
      }

      if (
        currentUser.contextRole !== UserRoleEnum.ADMIN &&
        (!scheduleProgrammed.admin ||
          scheduleProgrammed.admin.id !== currentUser.id)
      ) {
        throw new ForbiddenError(FORBIDDEN_ERRORS.NOT_AUTHORIZED);
      }

      const oldDays = scheduleProgrammed.daysOfWeek.map(day => Number(day));
      const newDays =
        updateData.daysOfWeek !== undefined
          ? updateData.daysOfWeek.map((day: any) => Number(day))
          : oldDays;

      // Actualizar metadata
      if (updateData.daysOfWeek !== undefined)
        scheduleProgrammed.daysOfWeek = newDays;
      if (updateData.startHour !== undefined)
        scheduleProgrammed.startHour = updateData.startHour;
      if (updateData.endHour !== undefined)
        scheduleProgrammed.endHour = updateData.endHour;
      if (updateData.maxUsers !== undefined)
        scheduleProgrammed.maxUsers = updateData.maxUsers;
      if (updateData.title !== undefined)
        scheduleProgrammed.title = updateData.title;
      if (updateData.description !== undefined)
        scheduleProgrammed.description = updateData.description;
      if (updateData.type !== undefined)
        scheduleProgrammed.type = updateData.type;
      if (updateData.age !== undefined) scheduleProgrammed.age = updateData.age;
      if (updateData.admin !== undefined)
        scheduleProgrammed.admin = tem.getReference(User, updateData.admin);

      // Restricted Schedule sobre la plantilla: omitir la lista la deja como
      // estaba; darla la pisa aquí y, más abajo, en todos los schedules
      // futuros de los días que se conservan. Se resuelve una sola vez — los
      // planes son los mismos para la plantilla y para lo que engendra.
      const allowedPlans =
        updateData.allowedPlanIds !== undefined
          ? await this.resolveAllowedPlans(tem, updateData.allowedPlanIds)
          : null;
      if (allowedPlans !== null) {
        scheduleProgrammed.allowedPlans.set(allowedPlans);
      }

      const now = moment();
      const futureSchedules = scheduleProgrammed.schedules
        .getItems()
        .filter(s => moment(s.startDate).isAfter(now));

      const daysToCancel = oldDays.filter(day => !newDays.includes(day));
      const daysToKeep = oldDays.filter(day => newDays.includes(day));
      const daysToCreate = newDays.filter(day => !oldDays.includes(day));

      // 1. Cancelar o eliminar schedules futuros en los días eliminados
      for (const futureSchedule of futureSchedules) {
        const dayOfWeek = moment(futureSchedule.startDate).day();
        if (daysToCancel.includes(dayOfWeek)) {
          const hasUsers =
            futureSchedule.users.length > 0 ||
            futureSchedule.waitListUsers.length > 0;

          if (hasUsers) {
            if (futureSchedule.state !== ScheduleState.CANCELLED) {
              await this.changeScheduleStatus(
                currentUser,
                futureSchedule.id,
                ScheduleState.CANCELLED,
                'Cambio de días en la programación semanal',
                tem
              );
            }
          } else {
            scheduleProgrammed.schedules.remove(futureSchedule);
            (tem || this.em).remove(futureSchedule);
          }
        }
      }

      // 2. Actualizar schedules futuros en los días que se mantienen
      for (const futureSchedule of futureSchedules) {
        const dayOfWeek = moment(futureSchedule.startDate).day();
        if (daysToKeep.includes(dayOfWeek)) {
          const updateParams: updateScheduleDataType = {
            currentUser,
            id: futureSchedule.id,
            title: updateData.title,
            description: updateData.description,
            maxUsers: updateData.maxUsers,
            type: updateData.type,
            age: updateData.age,
            admin: updateData.admin,
            startHour: updateData.startHour,
            endHour: updateData.endHour,
          };
          await this.updateSchedule(updateParams, tem);

          // Editar la plantilla pisa la restricción de todo schedule futuro,
          // haya divergido o no: quien cambia la política en la plantilla la
          // quiere aplicada ya. Lo pasado no se toca — `futureSchedules` ya
          // deja fuera los schedules anteriores a ahora.
          if (allowedPlans !== null) {
            futureSchedule.allowedPlans.set(allowedPlans);
          }
        }
      }

      // 3. Crear nuevos schedules para los días añadidos
      if (daysToCreate.length > 0) {
        await createInitialSchedules(scheduleProgrammed, tem, daysToCreate);
      }

      await tem.flush();

      return createServiceResponse(
        200,
        'Schedule programmed updated successfully',
        true,
        {
          scheduleProgrammed,
        }
      );
    });
  }

  public async updateSchedule(
    scheduleData: updateScheduleDataType,
    tem?: EntityManager
  ): Promise<ServiceResponse> {
    const {
      currentUser,
      id,
      title,
      description,
      maxUsers,
      age,
      admin,
      type,
      state,
      date,
      startHour,
      endHour,
      allowedPlanIds,
    } = scheduleData;

    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole === UserRoleEnum.STANDARD) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    const executeUpdate = async (emToUse: EntityManager) => {
      const scheduleRepo = emToUse.getRepository(Schedule);
      const schedule = await scheduleRepo.findOne(
        { id: id },
        {
          populate: [
            'admin',
            'users',
            'waitListUsers',
            'company',
            'allowedPlans',
          ],
        }
      );

      if (!schedule) {
        throw new NotFoundError('Schedule');
      }

      const originalStart = schedule.startDate
        ? moment(schedule.startDate)
        : null;
      const originalEnd = schedule.endDate ? moment(schedule.endDate) : null;

      // Solo el admin o el propio coach pueden editar
      if (
        currentUser.contextRole !== UserRoleEnum.ADMIN &&
        (!schedule.admin || schedule.admin.id !== currentUser.id)
      ) {
        throw new ForbiddenError(FORBIDDEN_ERRORS.NOT_AUTHORIZED);
      }

      if (title !== undefined) schedule.title = title;
      if (description !== undefined) schedule.description = description;

      if (date || startHour || endHour) {
        const baseDate = date ? moment(date) : moment(schedule.startDate);

        if (date || startHour) {
          const timeStr =
            startHour || moment(schedule.startDate).format('HH:mm');
          const [h, m] = timeStr.split(':').map(Number);
          schedule.startDate = baseDate
            .clone()
            .set({ hour: h, minute: m, second: 0, millisecond: 0 })
            .toDate();
        }

        if (date || endHour) {
          const timeStr = endHour || moment(schedule.endDate).format('HH:mm');
          const [h, m] = timeStr.split(':').map(Number);
          schedule.endDate = baseDate
            .clone()
            .set({ hour: h, minute: m, second: 0, millisecond: 0 })
            .toDate();
        }
      }

      const oldMaxUsers = schedule.maxUsers;
      if (maxUsers !== undefined) {
        if (maxUsers < schedule.users.length) {
          throw new ValidationError(VAL_ERRORS.MAX_USERS_BELOW_CURRENT);
        }
        schedule.maxUsers = maxUsers;
      }
      if (type !== undefined) schedule.type = type;
      if (state !== undefined) schedule.state = state;

      if (age !== undefined) {
        schedule.age = age && age > 0 ? age : null;
      }

      if (admin !== undefined) {
        schedule.admin = emToUse.getReference(User, admin);
      }

      // Restricted Schedule: omitir la lista deja la restricción como estaba;
      // una lista vacía la quita. Cambiarla nunca expulsa a quien ya está
      // inscrito — no hay barrido ni desalojo (ADR 0005).
      if (allowedPlanIds !== undefined) {
        schedule.allowedPlans.set(
          await this.resolveAllowedPlans(emToUse, allowedPlanIds)
        );
      }

      if (maxUsers !== undefined && maxUsers > oldMaxUsers) {
        const company = await emToUse.findOne(
          Company,
          { id: { $ne: null } },
          { populate: ['scheduleOptions'] }
        );
        const scheduleOptions = company?.scheduleOptions || null;

        while (
          schedule.users.length < schedule.maxUsers &&
          schedule.waitListUsers.length > 0
        ) {
          await this.promoteNextUser(schedule, scheduleOptions, emToUse);
        }
      }

      await emToUse.flush();

      const dateOrHourChanged =
        (originalStart &&
          schedule.startDate &&
          !originalStart.isSame(moment(schedule.startDate))) ||
        (originalEnd &&
          schedule.endDate &&
          !originalEnd.isSame(moment(schedule.endDate)));
      const hasUsers =
        schedule.users.length > 0 || schedule.waitListUsers.length > 0;

      if (dateOrHourChanged && hasUsers) {
        await this.sendScheduleDateChangeNotifications(schedule, emToUse);
      }

      return createServiceResponse(200, 'Schedule updated successfully', true, {
        schedule,
      });
    };

    if (tem) {
      return await executeUpdate(tem);
    } else {
      return await this.em.transactional(async transactionalEm => {
        try {
          return await executeUpdate(transactionalEm);
        } catch (error: any) {
          if (
            error?.isOperational ||
            error instanceof ForbiddenError ||
            error instanceof UnauthorizedError ||
            error instanceof NotFoundError ||
            error instanceof ValidationError
          ) {
            throw error;
          }
          throw new InternalServerError('Error updating schedule');
        }
      });
    }
  }

  /**
   * Agregar usuario a schedule
   */
  public async addUserToSchedule(
    currentUser: CurrentUser,
    scheduleId: string
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    const user = await this.em.findOne(
      User,
      { id: currentUser.id },
      {
        populate: [
          'schedules',
          'waitListSchedules',
          'waitListSchedules.waitListUsers',
        ],
        populateWhere: {
          schedules: { startDate: { $gte: new Date() } },
          waitListSchedules: { startDate: { $gte: new Date() } },
        },
      }
    );

    if (!user) {
      throw new NotFoundError(NOT_FND_ERRORS.USER);
    }

    const scheduleRepo = this.em.getRepository(Schedule);
    const schedule = await scheduleRepo.findOne(
      { id: scheduleId },
      { populate: ['users', 'admin', 'waitListUsers', 'allowedPlans'] }
    );

    if (!schedule) {
      throw new NotFoundError(NOT_FND_ERRORS.SCHEDULE);
    }

    const company = await this.em.findOne(
      Company,
      { id: { $ne: null } },
      { populate: ['scheduleOptions'] }
    );
    const scheduleOptions = company?.scheduleOptions || null;

    // Validaciones
    const isStateDisabled = schedule.state !== ScheduleState.AVAILABLE;
    const isHourDisabled = moment().isAfter(Number(schedule.startDate));
    const isFull = schedule.users.length >= schedule.maxUsers;
    const isBooked = user.schedules.getItems().some(s => s.id === schedule.id);
    const isWaitListed = user.waitListSchedules
      .getItems()
      .some(s => s.id === schedule.id);
    const isAdmin = currentUser.contextRole === UserRoleEnum.ADMIN;
    const isUserCoachOfEvent =
      currentUser.contextRole === UserRoleEnum.COACH &&
      schedule.admin.id === currentUser.id;

    const limits = this.checkUserBookingLimits(user, schedule, scheduleOptions);

    const maxAdvanceDate = moment()
      .add(scheduleOptions?.maxAdvanceBookingDays ?? 0, 'days')
      .startOf('day');

    const isAdvanceBookingDisabled =
      moment(Number(schedule.startDate)).isAfter(maxAdvanceDate) &&
      !scheduleOptions?.sameDayBookingAllowed;

    const {
      SCHEDULE_NOT_AVAILABLE,
      SCHEDULE_ALREADY_PASSED,
      MAX_ACTIVE_RESERVATIONS_REACHED,
      SAME_DAY_BOOKING_NOT_ALLOWED,
      ADVANCE_BOOKING_OUTSIDE_WINDOW,
      USER_ALREADY_IN_SCHEDULE,
    } = VAL_ERRORS;

    if (!(isAdmin || isUserCoachOfEvent)) {
      if (isStateDisabled) {
        throw new ValidationError(SCHEDULE_NOT_AVAILABLE);
      }
      if (isHourDisabled) {
        throw new ValidationError(SCHEDULE_ALREADY_PASSED);
      }

      if (!isBooked && !isWaitListed) {
        if (limits.isMaxUserBookingsReached) {
          throw new ValidationError(MAX_ACTIVE_RESERVATIONS_REACHED);
        }
        if (limits.isMaxUserBookingsTodayReached) {
          throw new ValidationError(SAME_DAY_BOOKING_NOT_ALLOWED);
        }
        if (isAdvanceBookingDisabled) {
          throw new ValidationError(ADVANCE_BOOKING_OUTSIDE_WINDOW);
        }
      }
    }

    if (
      schedule.users.contains(user) ||
      schedule.waitListUsers.contains(user)
    ) {
      throw new ValidationError(USER_ALREADY_IN_SCHEDULE);
    }

    // AQUÍ va el descuento de Session Credit cuando se implemente (ADR 0004):
    // antes que la restricción de planes, para que a quien tiene el plan
    // correcto pero no créditos se le diga que compre créditos, no que se
    // cambie de plan. Entrar en waitlist no consume crédito, pero sí exige
    // tener alguno: el descuento va en la promoción.
    //
    // Restricted Schedule: el gate va **después** del estado del schedule, de
    // los límites de reserva y de la ventana anticipada, para que el rechazo
    // que oye el miembro nombre el motivo que de verdad aplica y no tape
    // ninguno de ellos. Sin bypass de admin ni de coach: es una regla, no una
    // regla por rol.
    //
    // Va **antes** de repartir entre plaza y lista de espera (issue #11): el
    // aforo no es un rechazo del que la restricción pueda tapar nada, es una
    // bifurcación, y un miembro que nunca podría ocupar la plaza tampoco debe
    // esperar por ella. Así el mismo error vale para inscribirse y para
    // apuntarse a la lista.
    const planAccess = await this.getSchedulePlanAccess(currentUser, schedule);

    if (!planAccess.canRegister) {
      throw new ValidationError(VAL_ERRORS.PLAN_NOT_ALLOWED_IN_SCHEDULE);
    }

    let message = 'User added to schedule';
    if (isFull) {
      schedule.waitListUsers.add(user);
      user.waitListSchedules.add(schedule);
      message = 'User added to waitlist';
    } else {
      schedule.users.add(user);
      user.schedules.add(schedule);
      const limitsAfterBooking = this.checkUserBookingLimits(
        user,
        schedule,
        scheduleOptions
      );
      if (
        limitsAfterBooking.isMaxUserBookingsReached ||
        limitsAfterBooking.isMaxUserBookingsTodayReached
      ) {
        await this.cleanupUserWaitlists(
          user,
          schedule,
          limitsAfterBooking.isMaxUserBookingsReached,
          limitsAfterBooking.isMaxUserBookingsTodayReached
        );
      }
    }

    this.em.persist(schedule);
    await this.em.flush();

    return createServiceResponse(200, message, true, {
      schedule,
    });
  }

  /**
   * Planes que admite un schedule o una plantilla semanal (**Restricted
   * Schedule**). Inicializa la colección si hace falta.
   *
   * @param schedule - Schedule o Schedule Programmed del que se quiere la
   * restricción.
   * @returns Los planes admitidos; lista vacía ⇒ sin restricción.
   */
  public async getAllowedPlans(
    schedule: Schedule | ScheduleProgrammed
  ): Promise<Plan[]> {
    return await getAllowedPlansOf(schedule);
  }

  /**
   * Suscripciones **vigentes ahora mismo** del llamante en su empresa activa.
   *
   * @remarks Delega en `PermissionService`, que es donde vive la noción de
   * "suscripción vigente" que usan login y `hasActive`: duplicarla aquí la
   * haría derivar. Una Suscripción Futura (periodo aún no empezado) no cuenta,
   * aunque vaya a estar vigente el día de la clase — el gate mira el ahora, no
   * la fecha de la clase (ADR 0005).
   *
   * @param currentUser - Llamante autenticado.
   * @returns La suscripción vigente, o `null` si no hay ninguna.
   */
  public async findLiveSubscription(
    currentUser: CurrentUser
  ): Promise<Subscription | null> {
    if (!currentUser?.id || !currentUser.activeCompanyId) {
      return null;
    }

    return await this.findLiveSubscriptionForUser(
      currentUser.id,
      currentUser.activeCompanyId
    );
  }

  /**
   * Igual que {@link findLiveSubscription}, pero para un usuario que **no es
   * el llamante**.
   *
   * @remarks Lo necesita la promoción desde la lista de espera: ahí se evalúa
   * la elegibilidad de un candidato en nombre de nadie, así que no hay
   * `CurrentUser` del que sacar la empresa y hay que decirla explícitamente
   * (la del schedule).
   *
   * @param userId - Usuario cuya suscripción vigente se busca.
   * @param companyId - Empresa en la que se busca.
   * @param em - EntityManager (posiblemente transaccional) a usar.
   * @returns La suscripción vigente ahora mismo, o `null`.
   */
  private async findLiveSubscriptionForUser(
    userId: string,
    companyId: string,
    em: EntityManager = this.em
  ): Promise<Subscription | null> {
    const permissionService = new PermissionService(em);

    return await permissionService.getUserActiveSubscriptionInCompany(
      userId,
      companyId
    );
  }

  /**
   * ¿Puede este llamante inscribirse en este schedule, en lo que respecta a la
   * restricción de planes?
   *
   * @remarks Es la **única** implementación de la regla: los fronts la consumen
   * por GraphQL (`Schedule.planAccess`) en vez de recomputarla (ADR 0005).
   * Aplica a todos los roles: no hay bypass de admin ni de coach, igual que la
   * regla de Session Credit de ADR 0004.
   *
   * @param currentUser - Llamante que quiere inscribirse.
   * @param schedule - Schedule sobre el que se evalúa la restricción.
   * @param resolveLiveSubscription - Cómo obtener la suscripción vigente del
   * llamante. Por defecto la consulta; un resolver que evalúa muchos schedules
   * del mismo llamante pasa aquí una versión memorizada, porque estos
   * resolvers están limitados por latencia y la suscripción es la misma para
   * toda la petición.
   * @returns Si puede inscribirse, el motivo si no, y los planes exigidos.
   */
  public async getSchedulePlanAccess(
    currentUser: CurrentUser,
    schedule: Schedule,
    resolveLiveSubscription: () => Promise<Subscription | null> = () =>
      this.findLiveSubscription(currentUser)
  ): Promise<SchedulePlanAccess> {
    return await this.evaluatePlanAccess(schedule, resolveLiveSubscription);
  }

  /**
   * El núcleo de la restricción de planes, sin noción de llamante.
   *
   * @remarks `getSchedulePlanAccess` la evalúa para quien hace la petición;
   * la promoción desde la lista de espera la evalúa para un candidato. La
   * regla es una sola y vive aquí.
   *
   * @param schedule - Schedule sobre el que se evalúa la restricción.
   * @param resolveLiveSubscription - Cómo obtener la suscripción vigente de la
   * persona que se evalúa. No se llama si el schedule no está restringido.
   * @returns Si puede inscribirse, el motivo si no, y los planes exigidos.
   */
  private async evaluatePlanAccess(
    schedule: Schedule,
    resolveLiveSubscription: () => Promise<Subscription | null>
  ): Promise<SchedulePlanAccess> {
    const requiredPlans = await this.getAllowedPlans(schedule);

    if (requiredPlans.length === 0) {
      return { canRegister: true, reason: null, requiredPlans: [] };
    }

    const subscription = await resolveLiveSubscription();

    if (!subscription) {
      return {
        canRegister: false,
        reason: SchedulePlanAccessReason.NO_LIVE_SUBSCRIPTION,
        requiredPlans,
      };
    }

    const livePlanId = (subscription.plan as Plan | undefined)?.id;
    const isAllowed = requiredPlans.some(plan => plan.id === livePlanId);

    return {
      canRegister: isAllowed,
      reason: isAllowed ? null : SchedulePlanAccessReason.PLAN_NOT_ALLOWED,
      requiredPlans,
    };
  }

  /**
   * Resuelve ids de plan a entidades de la empresa activa.
   *
   * @remarks Usa `find()`, así que el filtro `companyContext` se aplica solo:
   * un plan de otra empresa sencillamente no aparece.
   *
   * @param emToUse - EntityManager (posiblemente transaccional) a usar.
   * @param allowedPlanIds - Ids de plan pedidos por el llamante.
   * @returns Los planes correspondientes, en el mismo orden que los devuelva la query.
   * @throws {ValidationError} Si algún id no es un plan de esta empresa.
   */
  private async resolveAllowedPlans(
    emToUse: EntityManager,
    allowedPlanIds: string[]
  ): Promise<Plan[]> {
    if (allowedPlanIds.length === 0) {
      return [];
    }

    const plans = await emToUse.find(Plan, { id: { $in: allowedPlanIds } });

    if (plans.length !== new Set(allowedPlanIds).size) {
      throw new ValidationError(VAL_ERRORS.PLAN_NOT_IN_COMPANY);
    }

    return plans;
  }

  /**
   * Remover usuario de schedule
   */
  public async removeUserFromSchedule(
    currentUser: CurrentUser,
    scheduleId: string,
    userId?: string
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    const scheduleRepo = this.em.getRepository(Schedule);
    const schedule = await scheduleRepo.findOne(
      { id: scheduleId },
      {
        populate: [
          'users',
          'admin',
          'waitListUsers',
          'waitListUsers.pushTokens',
          'company',
          'allowedPlans',
        ],
      }
    );

    if (!schedule) {
      throw new NotFoundError('Schedule');
    }

    let id = null;

    if (userId) {
      if (
        userId === currentUser.id ||
        (currentUser.contextRole === UserRoleEnum.COACH &&
          userId === schedule.admin.id) ||
        currentUser.contextRole === UserRoleEnum.ADMIN
      ) {
        id = userId;
      } else {
        throw new ForbiddenError(
          'You are not authorized to perform this action'
        );
      }
    } else {
      id = currentUser.id;
    }

    const user = await this.em.findOne(User, { id });

    if (!user) {
      throw new NotFoundError('User');
    }

    const company = await this.em.findOne(
      Company,
      { id: { $ne: null } },
      { populate: ['scheduleOptions'] }
    );
    const scheduleOptions = company?.scheduleOptions || null;

    let message = 'User removed from schedule';

    if (schedule.users.contains(user)) {
      schedule.users.remove(user);

      // Si hay gente en la waitlist, meter al primero
      await this.promoteNextUser(schedule, scheduleOptions);
    } else if (schedule.waitListUsers.contains(user)) {
      schedule.waitListUsers.remove(user);
      message = 'User removed from waitlist';
    } else {
      throw new ForbiddenError('User not in schedule or waitlist');
    }

    this.em.persist(schedule);
    await this.em.flush();

    return createServiceResponse(200, message, true, {
      schedule,
    });
  }

  /**
   * Crear schedule de desarrollo (solo para desarrollo)
   */
  public async createScheduleDevelopment(
    currentUser: CurrentUser,
    title: string,
    startTime: string,
    endTime: string,
    maxUsers: number,
    state: ScheduleState = ScheduleState.AVAILABLE
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    try {
      const newStartDate = createDateWithTime(startTime);
      const newEndDate = createDateWithTime(endTime);
      const admin = this.em.getReference(User, currentUser.id);

      const newSchedule = this.em.create(Schedule, {
        title,
        startDate: newStartDate,
        endDate: newEndDate,
        maxUsers,
        state,
        admin,
        company: currentUser.activeCompanyId!,
        type: ScheduleType.STANDARD,
      });

      this.em.persist(newSchedule);
      await this.em.flush();

      return createServiceResponse(200, 'Schedule created successfully', true);
    } catch (error: any) {
      throw new InternalServerError(`Error creating schedule ${error.message}`);
    }
  }

  /**
   * Cambiar estado de schedule (AVAILABLE <-> CANCELLED)
   */
  public async changeScheduleStatus(
    currentUser: CurrentUser,
    scheduleId: string,
    status: ScheduleState,
    reason?: string,
    tem?: EntityManager
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    const executeStatusChange = async (emToUse: EntityManager) => {
      const scheduleRepo = emToUse.getRepository(Schedule);
      const schedule = await scheduleRepo.findOne(
        { id: scheduleId },
        { populate: ['users', 'users.pushTokens', 'admin', 'company'] }
      );

      if (!schedule) {
        throw new NotFoundError('Schedule');
      }

      if (
        schedule.admin.id !== currentUser.id &&
        currentUser.contextRole !== UserRoleEnum.ADMIN
      ) {
        throw new ForbiddenError(
          'You are not authorized to perform this action'
        );
      }

      if (schedule.state === status) {
        return createServiceResponse(
          200,
          'Schedule status is already ' + status,
          true,
          {
            schedule,
          }
        );
      }

      schedule.state = status;

      emToUse.persist(schedule);
      await emToUse.flush();

      // Enviar notificaciones de cualquier cambio de estado
      await this.sendScheduleStatusChangeNotifications(
        schedule,
        status,
        reason
      );

      return createServiceResponse(
        200,
        'Schedule status changed successfully',
        true,
        {
          schedule,
        }
      );
    };

    if (tem) {
      return await executeStatusChange(tem);
    } else {
      return await executeStatusChange(this.em);
    }
  }

  /**
   * Remover schedule
   */
  public async removeSchedule(
    currentUser: CurrentUser,
    scheduleId: string
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    const scheduleRepo = this.em.getRepository(Schedule);
    const schedule = await scheduleRepo.findOne(
      { id: scheduleId },
      { populate: ['admin', 'users', 'waitListUsers'] }
    );

    if (!schedule) {
      throw new NotFoundError('Schedule');
    }

    if (
      schedule.admin.id !== currentUser.id &&
      currentUser.contextRole !== UserRoleEnum.ADMIN
    ) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    if (schedule.users.length > 0 || schedule.waitListUsers.length > 0) {
      throw new ValidationError(VAL_ERRORS.SCHEDULE_HAS_USERS);
    }

    this.em.remove(schedule);
    await this.em.flush();

    return createServiceResponse(200, 'Schedule removed successfully', true);
  }

  /**
   * Actualizar opciones de schedule (solo ADMIN)
   */
  public async updateScheduleOptions(
    currentUser: CurrentUser,
    maxActiveReservations: number,
    maxAdvanceBookingDays: number,
    sameDayBookingAllowed: boolean,
    fullOpenHours: number,
    bookingCutoffMinutes: number,
    minBookingsRequired: number,
    quotaWarningThresholds: number[]
  ): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    if (currentUser.contextRole !== UserRoleEnum.ADMIN) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    try {
      const scheduleOptionsRepo = this.em.getRepository(ScheduleOptions);
      let scheduleOptions = await scheduleOptionsRepo.findOne({
        company: currentUser.activeCompanyId,
      });

      scheduleOptions ??= this.em.create(
        ScheduleOptions,
        {} as ScheduleOptions
      );

      scheduleOptions.maxActiveReservations = maxActiveReservations;
      scheduleOptions.maxAdvanceBookingDays = maxAdvanceBookingDays;
      scheduleOptions.sameDayBookingAllowed = sameDayBookingAllowed;
      scheduleOptions.fullOpenHours = fullOpenHours;
      scheduleOptions.bookingCutoffMinutes = bookingCutoffMinutes;
      scheduleOptions.minBookingsRequired = minBookingsRequired;
      scheduleOptions.quotaWarningThresholds = quotaWarningThresholds;

      this.em.persist(scheduleOptions);
      await this.em.flush();

      return createServiceResponse(
        200,
        'Schedule options updated successfully',
        true,
        {
          scheduleOptions,
        }
      );
    } catch (error: any) {
      if (
        error instanceof ForbiddenError ||
        error instanceof UnauthorizedError
      ) {
        throw error;
      }
      throw new InternalServerError('Error updating schedule options');
    }
  }

  public async cutOffSchedules(): Promise<number> {
    let cancelledCount = 0;
    try {
      const now = moment();
      const twentyFourHoursLater = now.clone().add(24, 'hours').toDate();

      const scheduleRepo = this.em.getRepository(Schedule);
      const schedules = await scheduleRepo.find(
        {
          state: ScheduleState.AVAILABLE,
          startDate: { $gte: now.toDate(), $lte: twentyFourHoursLater },
        },
        {
          populate: [
            'users',
            'company',
            'company.scheduleOptions',
            'users.pushTokens',
            'admin',
            'admin.pushTokens',
          ],
          filters: false,
        }
      );

      const cancelledSchedules: Schedule[] = [];

      for (const schedule of schedules) {
        const options = schedule.company?.scheduleOptions;
        if (!options) continue;

        const cutoffMinutes = options.bookingCutoffMinutes || 0;

        const minBookings = options.minBookingsRequired || 0;

        // Si no hay requisitos de reserva o el tiempo de corte es 0 (deshabilitado), saltamos
        if (minBookings <= 0 || cutoffMinutes <= 0) {
          console.log(
            `Skipping schedule ${schedule.id} - No cutoff or min bookings set`
          );
          continue;
        }

        const cutoffTime = moment(schedule.startDate).subtract(
          cutoffMinutes,
          'minutes'
        );

        if (
          now.isSameOrAfter(cutoffTime) &&
          schedule.users.length < minBookings
        ) {
          console.log(
            `Cutting off schedule ${schedule.id} - Only ${schedule.users.length} bookings`
          );
          schedule.state = ScheduleState.CANCELLED;
          cancelledSchedules.push(schedule);
        }
      }

      if (cancelledSchedules.length > 0) {
        await this.em.flush();
        cancelledCount = cancelledSchedules.length;

        console.log(
          `Cancelled ${cancelledCount} schedules due to cutoff criteria.`
        );

        const cancelledSchedulesWithUsers = schedules.filter(s =>
          cancelledSchedules.includes(s)
        );

        // Enviar notificaciones
        for (const schedule of cancelledSchedulesWithUsers) {
          await this.sendScheduleCancellationNotifications(
            schedule,
            'No se ha alcanzado el número mínimo de reservas.'
          );
        }
      }
    } catch (error) {
      console.error('Error in cutOffSchedules:', error);
    }
    return cancelledCount;
  }

  public async checkQuotaThresholds(): Promise<number> {
    let warningsSent = 0;
    try {
      const now = moment().toDate();
      const scheduleRepo = this.em.getRepository(Schedule);
      const schedules = await scheduleRepo.find(
        {
          state: ScheduleState.AVAILABLE,
          startDate: { $gte: now },
        },
        {
          populate: [
            'users',
            'company',
            'company.scheduleOptions',
            'admin',
            'admin.pushTokens',
          ],
          filters: false,
        }
      );

      for (const schedule of schedules) {
        const options = schedule.company?.scheduleOptions;
        if (!options) continue;

        const thresholds = options.quotaWarningThresholds || [];
        if (thresholds.length === 0 || schedule.maxUsers <= 0) continue;

        const currentOcupancy =
          (schedule.users.length / schedule.maxUsers) * 100;
        const notified = schedule.notifiedQuotaThresholds || [];
        const newNotified: number[] = [...notified];
        let hasNewNotification = false;

        for (const threshold of thresholds) {
          if (currentOcupancy >= threshold && !notified.includes(threshold)) {
            const title = 'Alerta de Ocupación';
            const body = `El horario "${schedule.title}" ha alcanzado el ${threshold}% de ocupación (${schedule.users.length}/${schedule.maxUsers}).`;

            const admin = schedule.admin;
            if (admin) {
              const notificationService = new NotificationService(this.em);
              await notificationService.sendToUser(
                admin.id,
                title,
                body,
                {
                  scheduleId: schedule.id,
                  threshold,
                  type: 'warning',
                },
                schedule.company?.id
              );
            }
            warningsSent++;

            newNotified.push(threshold);
            hasNewNotification = true;
          }
        }

        if (hasNewNotification) {
          schedule.notifiedQuotaThresholds = newNotified;
          this.em.persist(schedule);
        }
      }

      await this.em.flush();
    } catch (error) {
      console.error('Error in checkQuotaThresholds:', error);
    }
    return warningsSent;
  }

  // ============= MÉTODOS PRIVADOS =============

  /**
   * Checks if a user has reached their maximum booking limits.
   */
  private checkUserBookingLimits(
    user: User,
    schedule: Schedule,
    scheduleOptions: ScheduleOptions | null
  ) {
    const availableUserSchedules = user.schedules
      .getItems()
      .filter(s => s.state === ScheduleState.AVAILABLE);

    const isMaxUserBookingsReached =
      availableUserSchedules.length >=
      (scheduleOptions?.maxActiveReservations || Infinity);

    const isMaxUserBookingsTodayReached =
      !scheduleOptions?.sameDayBookingAllowed &&
      availableUserSchedules.some(s =>
        moment(Number(s.startDate)).isSame(
          moment(Number(schedule.startDate)),
          'day'
        )
      );

    return {
      isMaxUserBookingsReached,
      isMaxUserBookingsTodayReached,
    };
  }

  /**
   * Removes user from other waitlisted schedules if they reached their limits.
   */
  private async cleanupUserWaitlists(
    user: User,
    currentSchedule: Schedule,
    maxReached: boolean,
    todayReached: boolean,
    em: EntityManager = this.em
  ): Promise<void> {
    const waitlists = user.waitListSchedules.getItems();
    for (const s of waitlists) {
      if (s.id === currentSchedule.id) {
        continue;
      }

      let shouldRemove = false;
      if (maxReached) {
        shouldRemove = true;
      } else if (todayReached) {
        const isSameDay = moment(Number(s.startDate)).isSame(
          moment(Number(currentSchedule.startDate)),
          'day'
        );
        if (isSameDay) {
          shouldRemove = true;
        }
      }

      if (shouldRemove) {
        if (!s.waitListUsers.isInitialized()) {
          await s.waitListUsers.init();
        }
        s.waitListUsers.remove(user);
        user.waitListSchedules.remove(s);
        em.persist(s);
      }
    }
  }

  /**
   * ¿Sigue cualificando este candidato de la lista de espera para la plaza que
   * ha quedado libre? (**Restricted Schedule**, issue #11.)
   *
   * @remarks La restricción se comprueba otra vez al promocionar, igual que la
   * regla de Session Credit de ADR 0004: entre apuntarse y que se libere la
   * plaza el candidato puede haber cambiado de plan o haberse quedado sin
   * suscripción. Se evalúa contra la empresa del schedule, no contra ninguna
   * "empresa activa" — aquí no hay llamante.
   *
   * @param schedule - Schedule con la plaza libre.
   * @param user - Candidato al que le tocaría la plaza.
   * @param em - EntityManager (posiblemente transaccional) a usar.
   * @returns `true` si puede ocupar la plaza.
   */
  private async isWaitlistCandidateStillEligible(
    schedule: Schedule,
    user: User,
    em: EntityManager
  ): Promise<boolean> {
    const access = await this.evaluatePlanAccess(
      schedule,
      async () =>
        await this.findLiveSubscriptionForUser(user.id, schedule.company.id, em)
    );

    return access.canRegister;
  }

  /**
   * Promotes the first valid user from the waitlist recursively/iteratively.
   */
  private async promoteNextUser(
    schedule: Schedule,
    scheduleOptions: ScheduleOptions | null,
    em: EntityManager = this.em
  ): Promise<void> {
    while (schedule.waitListUsers.length > 0) {
      const nextUser = schedule.waitListUsers.getItems()[0];
      try {
        const user = await em.findOne(
          User,
          { id: nextUser.id },
          {
            populate: [
              'schedules',
              'waitListSchedules',
              'waitListSchedules.waitListUsers',
              'pushTokens',
            ],
          }
        );

        if (!user) {
          schedule.waitListUsers.remove(nextUser);
          continue;
        }

        const { isMaxUserBookingsReached, isMaxUserBookingsTodayReached } =
          this.checkUserBookingLimits(user, schedule, scheduleOptions);

        if (isMaxUserBookingsReached || isMaxUserBookingsTodayReached) {
          schedule.waitListUsers.remove(user);
          await this.cleanupUserWaitlists(
            user,
            schedule,
            isMaxUserBookingsReached,
            isMaxUserBookingsTodayReached,
            em
          );
          em.persist(schedule);
          em.persist(user);
          continue;
        }

        // Restricted Schedule: el candidato que ha dejado de cualificar se
        // salta y **sale de esta lista** — no de las demás, que pueden estar
        // sin restringir o admitir su plan. La plaza cae al siguiente; si no
        // cualifica nadie, se queda libre antes que dársela a quien no puede
        // usarla. Va detrás de los límites de reserva, como al inscribirse,
        // para que sea el mismo orden el que decide en ambos sitios.
        //
        // El catch de fuera saca al candidato de la lista, que es lo correcto
        // para un candidato roto pero no para una consulta que ha fallado: un
        // fallo transitorio echaría a alguien que sí cualifica, y de la lista
        // no se vuelve. Si no se puede *determinar* la elegibilidad se corta
        // la promoción y la plaza se queda libre — reversible, a diferencia de
        // la expulsión.
        let stillEligible: boolean;
        try {
          stillEligible = await this.isWaitlistCandidateStillEligible(
            schedule,
            user,
            em
          );
        } catch (error) {
          console.error(
            `Could not determine waitlist eligibility for user ${user.id}; leaving the seat free:`,
            error
          );
          break;
        }

        if (!stillEligible) {
          schedule.waitListUsers.remove(user);
          user.waitListSchedules.remove(schedule);
          em.persist(schedule);
          em.persist(user);
          continue;
        }

        schedule.waitListUsers.remove(user);
        schedule.users.add(user);

        await this.sendWaitlistPromotionNotification(schedule, user, em);

        const limitsAfterPromotion = this.checkUserBookingLimits(
          user,
          schedule,
          scheduleOptions
        );
        if (
          limitsAfterPromotion.isMaxUserBookingsReached ||
          limitsAfterPromotion.isMaxUserBookingsTodayReached
        ) {
          await this.cleanupUserWaitlists(
            user,
            schedule,
            limitsAfterPromotion.isMaxUserBookingsReached,
            limitsAfterPromotion.isMaxUserBookingsTodayReached,
            em
          );
        }

        em.persist(schedule);
        em.persist(user);
        break;
      } catch (error) {
        console.error(
          `Error promoting user ${nextUser.id} from waitlist:`,
          error
        );
        schedule.waitListUsers.remove(nextUser);
      }
    }
  }

  /**
   * Enviar notificaciones de promoción de waitlist
   */
  private async sendWaitlistPromotionNotification(
    schedule: Schedule,
    user: User,
    em: EntityManager = this.em
  ): Promise<void> {
    try {
      const notificationService = new NotificationService(em);
      await notificationService.sendToUser(
        user.id,
        '¡Tienes plaza!',
        `Has sido movido de la lista de espera al horario "${schedule.title}".`,
        {
          type: 'info',
          scheduleId: schedule.id,
        },
        schedule.company?.id
      );
    } catch (error) {
      console.error('Error sending waitlist promotion notification:', error);
    }
  }

  /**
   * Enviar notificaciones de cancelación de schedule
   */
  private async sendScheduleCancellationNotifications(
    schedule: Schedule,
    description?: string
  ): Promise<void> {
    try {
      const title = 'Horario cancelado';
      const body = `El horario "${schedule.title}" ha sido cancelado. ${description}`;

      const userIds = [...schedule.users.getItems(), schedule.admin]
        .filter(user => user !== undefined)
        .map(user => user.id);

      const notificationService = new NotificationService(this.em);
      await notificationService.sendToUsers(
        userIds,
        title,
        body,
        {
          type: 'warning',
          scheduleId: schedule.id,
        },
        schedule.company?.id
      );
    } catch (error) {
      console.error(
        'Error sending schedule cancellation notifications:',
        error
      );
      // No lanzar error - las notificaciones son secundarias
    }
  }

  /**
   * Enviar notificaciones de cambio de estado de schedule
   */
  private async sendScheduleStatusChangeNotifications(
    schedule: Schedule,
    status: ScheduleState,
    reason?: string
  ): Promise<void> {
    try {
      const isCancelled = status === ScheduleState.CANCELLED;
      const title = isCancelled ? 'Horario cancelado' : 'Horario disponible';
      const body = isCancelled
        ? `El horario "${schedule.title}" ha sido cancelado.${reason ? ' ' + reason : ''}`
        : `El horario "${schedule.title}" vuelve a estar disponible.${reason ? ' ' + reason : ''}`;

      const userIds = [...schedule.users.getItems(), schedule.admin]
        .filter(user => user !== undefined)
        .map(user => user.id);

      const notificationService = new NotificationService(this.em);
      await notificationService.sendToUsers(
        userIds,
        title,
        body,
        {
          type: isCancelled ? 'warning' : 'info',
          scheduleId: schedule.id,
        },
        schedule.company?.id
      );
    } catch (error) {
      console.error(
        'Error sending schedule status change notifications:',
        error
      );
      // No lanzar error - las notificaciones son secundarias
    }
  }

  /**
   * Enviar notificaciones de cambio de fecha/hora de un schedule
   */
  private async sendScheduleDateChangeNotifications(
    schedule: Schedule,
    em: EntityManager = this.em
  ): Promise<void> {
    try {
      const title = 'Cambio de fecha/hora';
      const formattedDate = moment(schedule.startDate).format('DD/MM/YYYY');
      const formattedStartHour = moment(schedule.startDate).format('HH:mm');
      const formattedEndHour = moment(schedule.endDate).format('HH:mm');

      const body = `El horario "${schedule.title}" ha cambiado de fecha/hora. Nueva fecha: ${formattedDate} de ${formattedStartHour} a ${formattedEndHour}.`;

      const adminId = schedule.admin?.id;
      const enrolledUserIds = schedule.users.getItems().map(user => user.id);
      const waitListUserIds = schedule.waitListUsers
        .getItems()
        .map(user => user.id);

      const userIds = [
        ...new Set([...enrolledUserIds, ...waitListUserIds]),
      ].filter(id => id !== adminId);

      if (userIds.length === 0) {
        return;
      }

      const notificationService = new NotificationService(em);
      await notificationService.sendToUsers(
        userIds,
        title,
        body,
        {
          type: 'info',
          scheduleId: schedule.id,
        },
        schedule.company?.id
      );
    } catch (error) {
      console.error('Error sending schedule date change notifications:', error);
      // No lanzar error - las notificaciones son secundarias
    }
  }
}
