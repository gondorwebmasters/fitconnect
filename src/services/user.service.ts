import { EntityManager, FilterQuery } from '@mikro-orm/core';
import { SqlEntityManager } from '@mikro-orm/postgresql';
import moment from 'moment';

import { Company } from '../entities/Company';
import { Subscription, SubscriptionStatus } from '../entities/Subscription';
import { User } from '../entities/User';
import { UserRole } from '../entities/UserRole';
import { CurrentUser, ServiceResponse } from '../types/common.type';
import { UserRoleEnum } from '../types/enums';
import { PlanFilterInput, UpdateUserProps } from '../types/resolvers';
import {
  BadRequestError,
  createServiceResponse,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/errors.util';
import { createPictureUrl, getPresignedUrl, } from '../utils/presigned-urls.util';
import { updateUserSchema } from '../validation/schemas';

import { AuthService } from './auth.service';
import { BaseService } from './base.service';
import { CompanyService } from './company.service';
import { CustomerService } from './customer.service';
import { EmailService } from './email.service';
import { S3Service } from './s3.service';

/**
 * UserService
 *
 * Gestiona toda la lógica relacionada con los usuarios.
 * La única diferencia respecto a la versión anterior es que
 * el registro de cliente de billing pasa a ser un Customer propio
 * en lugar de un Stripe Customer.
 * El resto de la lógica (roles, permisos, auth, S3…) no cambia.
 */
export class UserService extends BaseService {
  private readonly emailService: EmailService;
  private readonly customerService: CustomerService;
  private readonly authService: AuthService;
  private readonly companyService: CompanyService;
  private readonly s3Service: S3Service;

  constructor(em: EntityManager) {
    super(em);
    this.emailService = EmailService.getInstance();
    this.customerService = new CustomerService(em);
    this.authService = new AuthService(em);
    this.companyService = new CompanyService(em);
    this.s3Service = new S3Service(em);
  }

  public async getUsers(
    currentUser: CurrentUser,
    query?: string,
    roleFilter?: string[],
    stateFilter?: string,
    page: number = 0,
    filterMe: boolean = true,
    planFilter?: PlanFilterInput
  ): Promise<ServiceResponse> {
    if (!currentUser) throw new UnauthorizedError();

    const pagination = { limit: 50, offset: page * 50 };
    const where = await this.buildUserFilter(
      query,
      roleFilter,
      stateFilter,
      currentUser,
      planFilter
    );
    const userRepo = this.em.getRepository(User);
    const isPendingSearch = stateFilter === 'pending';

    try {
      const users =
        Object.keys(where).length > 0
          ? await userRepo.find(where, {
              ...pagination,
              filters: isPendingSearch ? { companyContext: false } : true,
            })
          : await userRepo.findAll(pagination);

      const filteredUsers = filterMe
        ? users.filter(user => user.id !== currentUser.id)
        : users;

      return createServiceResponse(200, 'Users found', true, {
        users: filteredUsers,
      });
    } catch (e: any) {
      throw new InternalServerError(`Error fetching users: ${e.message}`);
    }
  }

  public async getMe(currentUser: CurrentUser): Promise<ServiceResponse> {
    if (!currentUser) {
      throw new UnauthorizedError('No está autorizado para acceder al recurso');
    }

    const authService = new AuthService(this.em);
    const userRepo = this.em.getRepository(User);
    const user = await userRepo.findOne(
      { id: currentUser.id },
      {
        populate: ['companies', 'companies.companyConfig'],
        filters: false,
      }
    );

    if (!user) throw new NotFoundError('User');

    const userCompanies = user.companies.getItems();
    const activeCompany = user.activeCompanyId
      ? userCompanies.find(c => c.id === user.activeCompanyId)
      : userCompanies[0];

    if (activeCompany) {
      return await authService.buildAuthResponseWithPermissions(
        user,
        activeCompany,
        'Login successful'
      );
    }

    return createServiceResponse(200, 'Logged in successfully', true, { user });
  }

  public async setActiveCompany(
    companyId: string,
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) throw new UnauthorizedError();

    const userRepo = this.em.getRepository(User);
    const user = await userRepo.findOne(
      { id: currentUser.id },
      {
        refresh: true,
        filters: false,
        populate: ['companies', 'companies.companyConfig'],
      }
    );

    if (!user) throw new NotFoundError('User');

    user.activeCompanyId = companyId;
    this.em.persist(user);

    const companyRepo = this.em.getRepository(Company);
    const company = await companyRepo.findOne(
      { id: companyId },
      { populate: ['companyConfig'], filters: { companyContext: false } }
    );

    if (
      user.isSuperAdmin &&
      !user.roles.toArray().some(r => {
        const companyIdInRole =
          typeof r.company === 'string' ? r.company : r.company?.id;
        return companyIdInRole === companyId;
      })
    ) {
      this.em.persist(
        this.em.create(UserRole, { user, company, role: UserRoleEnum.ADMIN })
      );
    }

    await this.em.flush();

    return await this.authService.buildAuthResponseWithPermissions(
      user,
      company as Company,
      'Company set successfully'
    );
  }

  public async findUser(
    id: string,
    currentUser: CurrentUser,
    options?: { includePermissions?: boolean }
  ): Promise<ServiceResponse> {
    const userRepo = this.em.getRepository(User);
    const user = await userRepo.findOne(
      {
        id,
        ...(options?.includePermissions
          ? {
              subscriptions: {
                status: {
                  $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
                },
              },
            }
          : {}),
        $or: [
          { companies: { id: currentUser.activeCompanyId } },
          { pendingCompanies: { id: currentUser.activeCompanyId } },
        ],
      },
      {
        populate: [
          'pendingCompanies',
          ...((options?.includePermissions
            ? [
                'subscriptions',
                'subscriptions.plan',
                'subscriptions.plan.planPermissions',
                'subscriptions.plan.planPermissions.permission',
              ]
            : []) as any[]),
        ],
        filters: { companyContext: false },
      }
    );

    if (user?.roles && typeof user.roles.set === 'function') {
      user.roles.set(
        user.roles
          .getItems()
          .filter(role => role.company.id === currentUser.activeCompanyId)
      );
    }

    if (!user) throw new NotFoundError('User');

    Object.assign(user, { isPending: user.pendingCompanies.length > 0 });

    return createServiceResponse(200, 'User found', true, { user });
  }

  public async createUser(
    userData: any,
    companyData?: any
  ): Promise<ServiceResponse> {
    const { email, password, nickname, role } = userData;

    if (!email || !password || !nickname) {
      throw new BadRequestError('Please provide all required fields');
    }

    if (role === UserRoleEnum.ADMIN && !companyData?.name) {
      throw new BadRequestError('Admin users must provide a Company name');
    }

    const existingByEmail = await this.em.findOne(
      User,
      { email },
      { filters: false }
    );
    if (existingByEmail) throw new BadRequestError('Email already exists');

    const existingByNickname = await this.em.findOne(
      User,
      { nickname },
      { filters: false }
    );
    if (existingByNickname) throw new BadRequestError('Nickname already exists');

    let newUser: User = this.em.create(User, userData);

    try {
      if (role === UserRoleEnum.ADMIN) {
        const { newUser: adminUser, newFirstForumMessage } =
          this.companyService.createAdminCompany(newUser, companyData);

        this.em.persist([newFirstForumMessage]);
        newUser = adminUser;

        if (newUser.activeCompanyId) {
          const companyToken =
            this.authService.generateCompanyVerificationToken(
              newUser.activeCompanyId
            );
          await this.emailService.sendCompanyVerificationEmail(
            companyToken,
            companyData,
            newUser
          );
        }
      }

      this.em.persist(newUser);
      await this.em.flush();

      // Crear el perfil de facturación interno (reemplaza a createStripeCustomer)
      /* await this.customerService.createCustomer({
        user: newUser,
        currency: 'eur',
      });*/

      let tokens: any = null;
      if (this.authService) {
        tokens = await this.authService.createTokensPair(newUser);
      }

      const emailToken = this.authService.generateEmailVerificationToken(email);
      await this.emailService.sendVerificationEmail(email, emailToken);

      return createServiceResponse(200, 'User created successfully', true, {
        user: newUser,
        tokens,
        isNewUser: true,
      });
    } catch (error: any) {
      if (error.code === 'EAUTH') {
        throw new Error(`Error sending verification email: ${error.message}`);
      }
      throw new InternalServerError(
        `Error creating user: ${error?.message || error?.name || 'Unknown error'}`
      );
    }
  }

  /**
   * Crea un usuario directamente desde el backoffice y lo admite de una vez
   * en la empresa activa del admin (crea el User, el Customer de billing y
   * el UserRole correspondiente). A diferencia de createUser (registro
   * público), no requiere verificación de email ni una solicitud de unión
   * previa: el admin lo está dando de alta y aceptando en un solo paso.
   */
  public async createCompanyMember(
    userData: {
      email: string;
      nickname: string;
      password: string;
      role: UserRoleEnum;
      isActive?: boolean;
    },
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    const { email, password, nickname, role, isActive } = userData;

    if (!email || !password || !nickname) {
      throw new BadRequestError('Please provide all required fields');
    }

    if (!currentUser?.activeCompanyId) {
      throw new BadRequestError('No active company selected');
    }

    const existingByEmail = await this.em.findOne(
      User,
      { email },
      { filters: false }
    );
    if (existingByEmail) throw new BadRequestError('Email already exists');

    const existingByNickname = await this.em.findOne(
      User,
      { nickname },
      { filters: false }
    );
    if (existingByNickname) throw new BadRequestError('Nickname already exists');

    const newUser = this.em.create(User, {
      email,
      nickname,
      password,
      isActive: isActive ?? true,
      isVerified: true,
    });

    this.em.persist(newUser);
    await this.em.flush();

    await this.customerService.createCustomer({
      user: newUser,
      currency: 'eur',
    });

    await this.companyService.admitUserToCompany(
      currentUser,
      currentUser.activeCompanyId,
      newUser.id,
      role,
      false,
      true
    );

    return createServiceResponse(201, 'Member created successfully', true, {
      user: newUser,
    });
  }

  public async updateUser(
    userUpdates: UpdateUserProps,
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    this.assertCanUpdate(userUpdates.id, currentUser);

    const user = await this.resolveUserForUpdate(userUpdates.id);

    this.validateUpdateSchema(userUpdates);

    await this.assertUniqueEmail(userUpdates.email, user.email, userUpdates.id);
    await this.assertUniqueNickname(
      userUpdates.nickname,
      user.nickname,
      userUpdates.id
    );

    this.applyUserFields(user, userUpdates);

    await this.applyRoleUpdate(
      user,
      userUpdates.role,
      currentUser.activeCompanyId
    );

    this.em.persist(user);
    await this.em.flush();

    return createServiceResponse(200, 'User updated successfully', true, {
      user,
    });
  }

  // ─────────────────────────────────────────────
  // PRIVADOS
  // ─────────────────────────────────────────────

  public async updateUserPicture(
    userId: string,
    pictureName: string,
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) throw new UnauthorizedError();

    if (
      currentUser.id !== userId &&
      currentUser.contextRole !== UserRoleEnum.ADMIN
    ) {
      throw new ForbiddenError();
    }

    const userRepo = this.em.getRepository(User);
    const user = await userRepo.findOne({ id: userId });
    if (!user) throw new NotFoundError('User');

    const url = await getPresignedUrl(pictureName);

    if (user.pictureUrl) {
      if (user.pictureUrl.name) {
        await this.s3Service.deleteObject(user.pictureUrl.name);
      }
      user.pictureUrl.name = pictureName;
      user.pictureUrl.url = url;
    } else {
      user.pictureUrl = createPictureUrl(
        this.em,
        { id: userId, name: pictureName, type: 'user' },
        url
      );
    }

    try {
      this.em.persist(user);
      await this.em.flush();

      return createServiceResponse(
        200,
        'User picture updated successfully',
        true,
        {
          user,
        }
      );
    } catch (error) {
      console.error('Error updating user picture:', error);
      throw new Error('Error updating user picture');
    }
  }

  public async sendEmailVerification(
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) throw new UnauthorizedError();

    const token = this.authService.generateEmailVerificationToken(
      currentUser.email
    );
    await this.emailService.sendVerificationEmail(currentUser.email, token);

    return createServiceResponse(200, 'Verification email sent', true);
  }

  public async getAdminStats(
    em: SqlEntityManager,
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) throw new UnauthorizedError();
    if (currentUser.contextRole !== UserRoleEnum.ADMIN)
      throw new ForbiddenError();

    const knex = em.getKnex();
    const companyId = currentUser.activeCompanyId ?? null;

    const result = await knex('user as u')
      .join('user_role as ur', 'u.id', 'ur.user_id')
      .where('ur.company_id', companyId)
      .select([
        knex.raw('COUNT(DISTINCT u.id) as totalusers'),
        knex.raw(
          'COUNT(DISTINCT CASE WHEN u.is_blocked = true THEN u.id END) as blockedusers'
        ),
        knex.raw(
          'COUNT(DISTINCT CASE WHEN u.is_active = false THEN u.id END) as notactiveusers'
        ),
        knex.raw(
          "COUNT(DISTINCT CASE WHEN u.created_at >= NOW() - INTERVAL '30 days' THEN u.id END) as newusers"
        ),
        knex.raw(
          `(SELECT COUNT(*) FROM user_pending_companies WHERE company_id = ?) as pendingusers`,
          [companyId]
        ),
        knex.raw(
          `(SELECT COUNT(*) FROM schedule WHERE company_id = ?) as schedulescount`,
          [companyId]
        ),
        knex.raw(
          `(SELECT COUNT(*) FROM poll WHERE company_id = ?) as pollscount`,
          [companyId]
        ),
        knex.raw(
          `(SELECT COUNT(*) FROM plan WHERE company_id = ? AND status = 'active') as planscount`,
          [companyId]
        ),
        knex.raw(
          `(SELECT COUNT(*) FROM subscription WHERE company_id = ? AND status = 'active') as subscriptionscount`,
          [companyId]
        ),
        knex.raw(
          `(SELECT COUNT(*) FROM transaction WHERE company_id = ?) as transactionscount`,
          [companyId]
        ),
        knex.raw(
          `(SELECT COUNT(*) FROM notification WHERE company_id = ?) as notificationscount`,
          [companyId]
        ),
      ]);

    const stats = {
      users: {
        totalUsers: result[0].totalusers,
        blockedUsers: result[0].blockedusers,
        notActiveUsers: result[0].notactiveusers,
        newUsers: result[0].newusers,
        pendingUsers: result[0].pendingusers,
      },
      schedules: Number(result[0].schedulescount) || 0,
      polls: Number(result[0].pollscount) || 0,
      plans: Number(result[0].planscount) || 0,
      subscriptions: Number(result[0].subscriptionscount) || 0,
      transactions: Number(result[0].transactionscount) || 0,
      notifications: Number(result[0].notificationscount) || 0,
    };

    return createServiceResponse(200, 'Stats found', true, { stats });
  }

  public async getUsersByPermissions(
    permissions: string[],
    extraWhere?: FilterQuery<User>
  ) {
    return this.em.find(
      User,
      {
        ...((extraWhere ?? {}) as object),
        subscriptions: {
          status: {
            $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
          },
          plan: {
            planPermissions: {
              permission: { name: { $in: permissions } },
            },
          },
        },
      },
      {
        populate: [
          'subscriptions',
          'subscriptions.plan',
          'subscriptions.plan.planPermissions',
          'subscriptions.plan.planPermissions.permission',
        ],
      }
    );
  }

  public async deleteUser(
    userId: string,
    currentUser: CurrentUser
  ): Promise<ServiceResponse> {
    if (!currentUser) throw new UnauthorizedError();

    const isSelfDelete = currentUser.id === userId;

    if (!isSelfDelete) {
      // Ningún admin (ni siquiera un superadmin) puede borrar la cuenta de
      // un cliente. "Eliminar" un miembro solo revoca su UserRole en la
      // empresa activa del admin; la cuenta del usuario se conserva
      // (podría pertenecer a otras empresas).
      if (!currentUser.activeCompanyId) {
        throw new ForbiddenError();
      }

      if (!currentUser.isSuperAdmin) {
        const requesterRole = await this.em.findOne(UserRole, {
          user: currentUser.id,
          company: currentUser.activeCompanyId,
          role: UserRoleEnum.ADMIN,
        });
        if (!requesterRole) throw new ForbiddenError();
      }

      const targetRole = await this.em.findOne(
        UserRole,
        { user: userId, company: currentUser.activeCompanyId },
        { filters: false }
      );
      if (!targetRole) throw new NotFoundError('User');
      if (targetRole.role === UserRoleEnum.ADMIN && !currentUser.isSuperAdmin) {
        throw new ForbiddenError(
          'Solo un superadmin puede borrar cuentas de admin'
        );
      }

      this.em.remove(targetRole);
      await this.em.flush();
      return createServiceResponse(
        200,
        'Member removed from company successfully',
        true
      );
    }

    const user = await this.em.findOne(
      User,
      { id: userId },
      { filters: false }
    );

    if (!user) throw new NotFoundError('User');

    try {
      this.em.remove(user);
      await this.em.flush();
      return createServiceResponse(200, 'User deleted successfully', true);
    } catch (error) {
      console.error('Error deleting user:', error);
      throw new Error('Error deleting user');
    }
  }

  private assertCanUpdate(targetId: string, currentUser: CurrentUser): void {
    if (!currentUser) throw new UnauthorizedError();
    if (
      currentUser.id !== targetId &&
      currentUser.contextRole !== UserRoleEnum.ADMIN
    ) {
      throw new ForbiddenError();
    }
  }

  private async resolveUserForUpdate(userId: string): Promise<User> {
    const user = await this.em.findOne(
      User,
      { id: userId },
      { populate: ['companies', 'roles'] }
    );
    if (!user) throw new NotFoundError('User');
    return user;
  }

  private validateUpdateSchema(userUpdates: UpdateUserProps): void {
    try {
      updateUserSchema.parse(userUpdates);
    } catch (error: any) {
      throw new BadRequestError(error.message);
    }
  }

  private async assertUniqueEmail(
    newEmail: string | undefined,
    oldEmail: string | undefined,
    userId: string
  ): Promise<void> {
    if (!newEmail || newEmail === oldEmail) return;

    const existing = await this.em.findOne(User, { email: newEmail });
    if (existing && existing.id !== userId) {
      throw new BadRequestError('Email already exists');
    }
  }

  private async assertUniqueNickname(
    newNickname: string | undefined,
    oldNickname: string | undefined,
    userId: string
  ): Promise<void> {
    if (!newNickname || newNickname === oldNickname) return;

    const existing = await this.em.findOne(User, { nickname: newNickname });
    if (existing && existing.id !== userId) {
      throw new BadRequestError('Nickname already exists');
    }
  }

  private applyUserFields(user: User, updates: UpdateUserProps): void {
    const nextIsBlocked = updates.isBlocked ?? user.isBlocked;
    const blockedAt =
      nextIsBlocked === user.isBlocked
        ? user.blockedAt
        : nextIsBlocked
          ? new Date()
          : null;

    // "Baja" = un admin marca al usuario como inactivo (no el bloqueo de acceso,
    // que es una restricción distinta). churnedAt alimenta el reporte de bajas.
    const nextIsActive = updates.isActive ?? user.isActive;
    const churnedAt =
      nextIsActive === user.isActive
        ? user.churnedAt
        : nextIsActive
          ? null
          : new Date();

    Object.assign(user, {
      name: updates.name ?? user.name,
      email: updates.email ?? user.email,
      surname: updates.surname ?? user.surname,
      nickname: updates.nickname ?? user.nickname,
      phoneNumber: updates.phoneNumber ?? user.phoneNumber,
      isActive: nextIsActive,
      churnedAt,
      isBlocked: nextIsBlocked,
      blockedAt,
      birthDate: updates.birthDate ?? user.birthDate,
    });
  }

  private async applyRoleUpdate(
    user: User,
    role: UserRoleEnum | undefined,
    activeCompanyId: string | null | undefined
  ): Promise<void> {
    if (!role) return;

    if (user.roles.length > 0) {
      user.roles[0].role = role;
      return;
    }

    if (!activeCompanyId) return;

    const company = await this.em.findOne(Company, { id: activeCompanyId });
    if (!company) return;

    user.roles.add(this.em.create(UserRole, { user, company, role }));
  }

  // ─────────────────────────────────────────────
  // PRIVADOS
  // ─────────────────────────────────────────────

  private async buildUserFilter(
    query?: string,
    roleFilter?: string[],
    stateFilter?: string,
    currentUser?: CurrentUser,
    planFilter?: PlanFilterInput
  ): Promise<FilterQuery<User>> {
    const where: FilterQuery<User> = {};

    if (query) {
      where.$or = [
        { nickname: { $ilike: `${query}%` } },
        { name: { $ilike: `${query}%` } },
        { surname: { $ilike: `${query}%` } },
        { email: { $ilike: `${query}%` } },
      ];
    }

    if (roleFilter) {
      // @ts-ignore
      where.roles = { role: { $in: roleFilter } };
    }

    if (stateFilter) {
      switch (stateFilter) {
        case 'inactive':
          where.isActive = false;
          break;
        case 'blocked':
          where.isBlocked = true;
          break;
        case 'notVerified':
          where.isVerified = false;
          break;
        case 'new':
          where.created_at = {
            $gte: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
          };
          break;
        case 'pending':
          if (currentUser?.activeCompanyId) {
            where.pendingCompanies = { id: currentUser.activeCompanyId };
          }
          break;
      }
    }

    if (planFilter) {
      const now = moment().toDate();
      const subscriptionFilter: any = {
        plan: planFilter.id,
        status: {
          $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
        currentPeriodStart: { $lte: now },
        currentPeriodEnd: { $gte: now },
      };

      if (currentUser?.activeCompanyId) {
        subscriptionFilter.company = currentUser.activeCompanyId;
      }

      if (planFilter.condition === 'with') {
        where.subscriptions = subscriptionFilter;
      } else {
        const activeSubUsers = await this.em
          .getRepository(Subscription)
          .find(subscriptionFilter, { fields: ['user.id'] });
        const activeUserIds = activeSubUsers.map(sub => sub.user.id);
        if (activeUserIds.length > 0) {
          where.id = { $nin: activeUserIds };
        }
      }
    }

    return where;
  }
}
