import {
  BeforeCreate,
  Collection,
  Entity,
  Filter,
  Index,
  ManyToMany,
  OneToMany,
  OneToOne,
  OptionalProps,
  Property,
  t,
} from '@mikro-orm/core';
import bcrypt from 'bcrypt';

import { UserProviderType, UserRoleEnum } from '../types/enums';

import { BaseEntity } from './BaseEntity';
import { Company } from './Company';
import { Message } from './Message';
import { PictureUrl } from './PictureUrl';
import { Poll } from './Poll';
import { PollVote } from './PollVote';
import { PushToken } from './PushToken';
import { RefreshToken } from './RefreshToken';
import { Schedule } from './Schedule';
import { ScheduleRegistration } from './ScheduleRegistration';
import { Subscription } from './Subscription';
import { TrainingTask } from './TraningITask';
import { Transaction } from './Transaction';
import { UserRole } from './UserRole';
import { UserWeight } from './UserWeight';

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING = 'pending',
}

@Entity()
@Filter({
  name: 'companyContext',
  cond: args => ({
    $or: [
      // { roles: { company: args.companyId } },
      { companies: { id: args.companyId } },
      // { pendingCompanies: { id: args.companyId } },
    ],
  }),
  default: true,
})
export class User extends BaseEntity {
  [OptionalProps]?:
    | 'isActive'
    | 'isBlocked'
    | 'isVerified'
    | 'isAdminVerified'
    | 'created_at'
    | 'updated_at'
    | 'isSuperAdmin'
    | 'fullName';

  @Property({ type: t.string, nullable: true })
  name?: string | null;

  @Property({ type: t.string, nullable: true })
  surname?: string | null;

  @Property({ type: t.string, lazy: true, nullable: true }) // means that the property will be loaded only when accessed
  password?: string | null;

  @Property({ type: t.string, unique: true })
  @Index()
  email!: string | undefined;

  @Property({ nullable: true })
  phoneNumber?: string | null;

  @Property({ type: t.string, unique: true })
  nickname!: string;

  @Property({ type: t.boolean, default: false })
  isSuperAdmin: boolean = false;

  @Property({ type: t.boolean, default: true })
  isActive: boolean = true;

  @Property({ type: t.boolean, default: false })
  isBlocked: boolean = false;

  @Property({ type: t.datetime, nullable: true })
  blockedAt?: Date | null;

  /** Fecha en que un admin marcó al usuario como inactivo (baja). */
  @Property({ type: t.datetime, nullable: true })
  churnedAt?: Date | null;

  @Property({ type: t.datetime, nullable: true })
  birthDate?: Date | null;

  @Property({ type: t.boolean, default: false })
  isVerified: boolean = false;

  @Property({ type: t.boolean, default: false })
  isAdminVerified: boolean = false;

  @Property({ type: t.string, nullable: true })
  provider?: UserProviderType = UserProviderType.LOCAL;

  @Property({ type: t.string, nullable: true, unique: true })
  @Index()
  appleId?: string | null;

  @ManyToMany({
    entity: () => Company,
    inversedBy: (company: Company) => company.users,
    pivotEntity: () => UserRole,
    joinColumn: 'user_id',
    inverseJoinColumn: 'company_id',
    owner: true,
  })
  companies = new Collection<Company>(this);

  @ManyToMany(() => Company, (company: Company) => company.pendingUsers, {
    owner: true,
  })
  pendingCompanies = new Collection<Company>(this);

  //solo se usa para la autenticacion
  @Property({ type: t.string, nullable: true })
  activeCompanyId?: string | null;

  @OneToMany(() => UserRole, userRole => userRole.user, {
    eager: true,
    orphanRemoval: true,
  })
  roles = new Collection<UserRole>(this);

  // @ManyToMany(() => Plan, (plan: Plan) =>plans.users, {
  //   owner: true,
  // })
  //plans  = new Collection<Plan>(this);

  /**
   * Las reservas del miembro. La pivote es una entidad con nombre
   * ({@link ScheduleRegistration}) porque guarda **qué suscripción pagó** cada
   * reserva (ADR 0006, decisión 6); la colección se usa igual que siempre.
   */
  @ManyToMany(() => Schedule, (schedule: Schedule) => schedule.users, {
    owner: true,
    pivotEntity: () => ScheduleRegistration,
  })
  schedules = new Collection<Schedule>(this);

  @ManyToMany({
    entity: () => Schedule,
    mappedBy: 'waitListUsers',
  })
  waitListSchedules = new Collection<Schedule>(this);

  // Relación OneToMany con Schedule (admin)
  @OneToMany(() => Schedule, schedule => schedule.admin, { lazy: true })
  adminSchedules = new Collection<Schedule>(this);

  // Relación OneToMany con Message (sender)
  @OneToMany(() => Message, message => message.sender, { lazy: true })
  messagesSent = new Collection<Message>(this);

  // Relación OneToMany con Message (receiver)
  @OneToMany(() => Message, message => message.receiver, { lazy: true })
  messagesReceived = new Collection<Message>(this);

  @OneToMany(() => Poll, poll => poll.admin, { lazy: true })
  adminPolls = new Collection<Poll>(this);

  @OneToMany(() => PollVote, PollVote => PollVote.user, { lazy: true })
  pollVotes = new Collection<PollVote>(this);

  @OneToMany(() => Subscription, subscription => subscription.user, {
    orphanRemoval: true,
  })
  subscriptions = new Collection<Subscription>(this);

  @OneToMany(() => Transaction, transaction => transaction.user)
  transactions = new Collection<Transaction>(this);

  /*  @Property({ nullable: true })
  customer?: string;*/

  @OneToMany(() => TrainingTask, trainingTask => trainingTask.user, {
    lazy: true,
  })
  trainingTasks = new Collection<TrainingTask>(this);

  @OneToMany(() => UserWeight, userWeight => userWeight.user, {
    lazy: true,
  })
  userWeights = new Collection<UserWeight>(this);

  @OneToOne(() => PictureUrl, picture => picture.user, {
    nullable: true,
    owner: true,
    eager: true,
  })
  pictureUrl?: PictureUrl;

  @OneToMany(() => RefreshToken, refreshToken => refreshToken.user, {
    lazy: true,
  })
  refreshTokens = new Collection<RefreshToken>(this);

  @OneToMany(() => PushToken, pushToken => pushToken.user, { lazy: true })
  pushTokens = new Collection<PushToken>(this);

  constructor(user: User) {
    super();
    this.name = user.name;
    this.surname = user.surname;
    this.nickname = user.nickname!;
    this.isActive = true;
    this.isBlocked = false;
    this.password = user.password;
    this.provider = user.provider || UserProviderType.LOCAL;
  }

  get fullName(): string {
    return `${this.name} ${this.surname}`;
  }

  get contextRole(): UserRoleEnum | null {
    if (this.isSuperAdmin) {
      return UserRoleEnum.ADMIN;
    }
    if (!this.roles.isInitialized()) {
      return null;
    }
    return this.roles[0]?.role ?? null;
  }

  // get contextPlan(): Plan | null {
  //   if (!this.plans.isInitialized()) {
  //     return null;
  //   }
  //   return this.plans.length > 0 ? this.plans[0] : null;
  // }

  /* @BeforeCreate()
     @BeforeUpdate()
     validateEmail() {
         const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
         if (!emailRegex.test(this.email)) {
             throw new Error('Invalid email format');
         }
     }*/

  @BeforeCreate()
  async hashPassword() {
    if (this.password) {
      // Hasheamos la contraseña con bcrypt
      const saltRounds = 10;
      this.password = await bcrypt.hash(this.password, saltRounds); // Aseguramos que la contraseña se hashee correctamente
    }
  }

  async checkPassword(password: string): Promise<boolean> {
    if (this.password === undefined) {
      throw new Error(
        "La propiedad password no ha sido cargada. Asegúrate de usar populate: ['password']"
      );
    }

    if (!this.password) {
      return false;
    }

    return bcrypt.compare(password, this.password);
  }
}
