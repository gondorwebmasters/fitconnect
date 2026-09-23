import {
  BeforeCreate,
  BeforeUpdate,
  Collection,
  Entity,
  Filter,
  ManyToMany,
  ManyToOne,
  Property,
} from '@mikro-orm/core';

import { ScheduleState, ScheduleType } from '../types/enums';
import { ValidationError, VAL_ERRORS } from '../utils/errors.util';

import { BaseEntity } from './BaseEntity';
import { Company } from './Company';
import { Plan } from './Plan';
import { ScheduleProgrammed } from './ScheduleProgrammed';
import { User } from './User';

@Entity()
@Filter({
  name: 'companyContext',
  cond: args => ({ company: args.companyId }),
  default: true,
})
export class Schedule extends BaseEntity {
  @Property()
  title: string;

  @Property({ nullable: true })
  description: string | null;

  @Property({ nullable: true })
  age: number | null;

  @Property() //puede haber 2 schedules en la misma hora?
  startDate: Date;

  @Property()
  endDate: Date;

  @Property()
  maxUsers: number;

  @ManyToOne(() => Company)
  company: Company;

  @Property({ default: ScheduleType.STANDARD })
  type: ScheduleType = ScheduleType.STANDARD;

  @Property({ default: ScheduleState.AVAILABLE })
  state: ScheduleState;

  @ManyToMany(() => User, user => user.schedules)
  users = new Collection<User>(this);

  @ManyToMany({
    entity: () => User,
    inversedBy: 'waitListSchedules',
    fixedOrder: true,
    owner: true,
  })
  waitListUsers = new Collection<User>(this);

  @ManyToOne(() => User)
  admin: User;

  /**
   * Restricted Schedule (Horario Restringido): planes que admite este schedule.
   * Colección vacía ⇒ sin restricción (abierto a todo el mundo), que es lo que
   * es y sigue siendo cualquier schedule existente. Se evalúa solo al
   * inscribirse; una reserva ya hecha nunca se revoca. Ver ADR 0005 y
   * CONTEXT.md → Restricted Schedule.
   */
  @ManyToMany({
    entity: () => Plan,
    owner: true,
    pivotTable: 'schedule_allowed_plans',
    joinColumn: 'schedule_id',
    inverseJoinColumn: 'plan_id',
  })
  allowedPlans = new Collection<Plan>(this);

  @ManyToOne(() => ScheduleProgrammed, { nullable: true })
  scheduleProgrammed?: ScheduleProgrammed;

  @Property({ type: 'json', default: '[]' })
  notifiedQuotaThresholds: number[] = [];

  constructor(schedule: Schedule) {
    super();
    this.startDate = schedule.startDate;
    this.endDate = schedule.endDate;
    this.maxUsers = schedule.maxUsers;
    this.state = schedule.state;
    this.admin = schedule.admin;
    this.title = schedule.title;
    this.description = schedule.description;
    this.age = schedule.age;
    this.notifiedQuotaThresholds = schedule.notifiedQuotaThresholds || [];
  }

  @BeforeCreate()
  @BeforeUpdate()
  validate() {
    if (this.startDate >= this.endDate) {
      throw new ValidationError(VAL_ERRORS.START_DATE_MUST_BE_BEFORE_END_DATE);
    }
  }
}
