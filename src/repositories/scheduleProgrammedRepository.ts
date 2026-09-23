import { EntityRepository } from '@mikro-orm/postgresql';
import moment from 'moment';

import { ScheduleProgrammed } from '../entities/ScheduleProgrammed';
import { createScheduleInXWeeks } from '../utils/schedules.util';

export class CustomScheduleProgrammedRepository extends EntityRepository<ScheduleProgrammed> {
  // Métodos personalizados...
  public async createSchedulesFromSchedulesProgrammed(): Promise<number> {
    let createdCount = 0;

    await this.em.transactional(async tem => {
      // Las plantillas se cargan **dentro** de la transacción: los schedules
      // que engendran nacen con la restricción de planes de su plantilla
      // (issue #12), y esos `Plan` acaban en una colección de una entidad del
      // `tem` — traerlos del EM de fuera sería cruzar EntityManagers.
      // `allowedPlans` viaja en el populate para no pagar una consulta por
      // plantilla dentro del bucle.
      const schedulesProgrammed = await tem
        .getRepository(ScheduleProgrammed)
        .findAll({ populate: ['allowedPlans'] });

      for (const scheduleProgrammed of schedulesProgrammed) {
        for (const day of scheduleProgrammed.daysOfWeek) {
          const created = await createScheduleInXWeeks(
            moment(),
            day,
            2, //0 es para la siguiente semana, 1 para la otra ...
            scheduleProgrammed,
            tem
          );
          if (created) {
            createdCount++;
          }
        }
      }
      await tem.flush();
    });

    return createdCount;
  }
}
