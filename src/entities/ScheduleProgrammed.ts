import {
  Collection,
  Entity,
  EntityRepositoryType,
  Filter,
  ManyToMany,
  ManyToOne,
  OneToMany,
  Property,
} from '@mikro-orm/core';

import { CustomScheduleProgrammedRepository } from '../repositories/scheduleProgrammedRepository';
import { ScheduleType } from '../types/enums';

import { BaseEntity } from './BaseEntity';
import { Company } from './Company';
import { Plan } from './Plan';
import { Schedule } from './Schedule';
import { User } from './User';

@Filter({
  name: 'companyContext',
  cond: args => ({ company: args.companyId }),
  default: true,
})
@Entity({ repository: () => CustomScheduleProgrammedRepository })
export class ScheduleProgrammed extends BaseEntity {
  [EntityRepositoryType]?: CustomScheduleProgrammedRepository;
  @Property({ columnType: 'integer[]' })
  daysOfWeek: number[];

  @Property({ type: 'time' })
  startHour: string;

  @Property({ type: 'time' })
  endHour: string; // in minutes

  @Property()
  maxUsers: number;

  @ManyToOne(() => User, { nullable: true })
  admin?: User;

  @Property()
  title: string;

  @Property()
  description: string;

  @Property({ default: ScheduleType.STANDARD })
  type: ScheduleType = ScheduleType.STANDARD;

  @Property({ nullable: true })
  age: number | null;

  /**
   * Restricted Schedule sobre la plantilla semanal: planes que admiten los
   * schedules que engendra. Colección vacía ⇒ plantilla sin restricción, que
   * sigue engendrando schedules abiertos.
   *
   * La plantilla **siembra** esta restricción en cada schedule que crea; un
   * schedule puede divergir después, pero editar la plantilla vuelve a pisar
   * la de todos los futuros, igual que hace con título, aforo, tipo o coach
   * (issue #12). Ver CONTEXT.md → Restricted Schedule.
   */
  @ManyToMany({
    entity: () => Plan,
    owner: true,
    pivotTable: 'schedule_programmed_allowed_plans',
    joinColumn: 'schedule_programmed_id',
    inverseJoinColumn: 'plan_id',
  })
  allowedPlans = new Collection<Plan>(this);

  @OneToMany(() => Schedule, schedule => schedule.scheduleProgrammed)
  schedules = new Collection<Schedule>(this);

  @ManyToOne(() => Company)
  company: Company;

  constructor(scheduleProgrammed: ScheduleProgrammed) {
    super();
    this.daysOfWeek = scheduleProgrammed.daysOfWeek;
    this.startHour = scheduleProgrammed.startHour;
    this.endHour = scheduleProgrammed.endHour;
    this.maxUsers = scheduleProgrammed.maxUsers;
    this.admin = scheduleProgrammed.admin;
    this.title = scheduleProgrammed.title;
    this.description = scheduleProgrammed.description;
    this.age = scheduleProgrammed.age;
  }
}
