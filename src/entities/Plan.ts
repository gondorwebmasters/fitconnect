import {
  Collection,
  Entity,
  Enum,
  Filter,
  Index,
  ManyToOne,
  OneToMany,
  Property,
  Unique,
} from '@mikro-orm/core';

import { BaseEntity } from './BaseEntity';
import { Company } from './Company';
import { PlanPermission } from './PlanPermission';
import { Subscription } from './Subscription';

export enum PlanInterval {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  YEAR = 'year',
}

export enum PlanStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ARCHIVED = 'archived',
}

@Entity()
@Unique({ properties: ['name', 'company'] })
@Filter({
  name: 'companyContext',
  cond: args => ({ company: args.companyId }),
  default: true,
})
export class Plan extends BaseEntity {
  @Property({ length: 100 })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'bigint' })
  amount!: number; // en centavos

  @Property({ length: 10, default: 'eur' })
  currency: string = 'eur';

  @Enum(() => PlanInterval)
  interval!: PlanInterval;

  @Property({ type: 'smallint', default: 1 })
  intervalCount: number = 1;

  @Property({ type: 'smallint', nullable: true })
  trialPeriodDays?: number = 7;

  /**
   * Session Pack (Bono): número finito de Session Credits que incluye el plan.
   * null ⇒ ilimitado (plan temporal clásico). Ver CONTEXT.md → Session Pack.
   */
  @Property({ type: 'smallint', nullable: true })
  sessionCount?: number | null;

  @Enum(() => PlanStatus)
  @Index()
  status: PlanStatus = PlanStatus.ACTIVE;

  @Property({ type: 'boolean', default: true })
  @Index()
  isActive: boolean = true;

  @Property({ type: 'json', nullable: true })
  features?: string[];

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, any>;

  // Relaciones
  @OneToMany(() => PlanPermission, pp => pp.plan)
  planPermissions = new Collection<PlanPermission>(this);

  @OneToMany(() => Subscription, subscription => subscription.plan)
  subscriptions = new Collection<Subscription>(this);

  @ManyToOne(() => Company, { nullable: true })
  company?: Company;

  formattedAmount(): string {
    return (this.amount / 100).toFixed(2);
  }

  displayInterval(): string {
    const interval =
      this.intervalCount === 1
        ? this.interval
        : `${this.intervalCount} ${this.interval}s`;
    return `per ${interval}`;
  }
}
