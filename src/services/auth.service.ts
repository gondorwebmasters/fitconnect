import crypto from 'node:crypto';

import { EntityManager } from '@mikro-orm/core';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import moment from 'moment';

import { Company } from '../entities/Company';
import { RefreshToken } from '../entities/RefreshToken';
import { User } from '../entities/User';
import {
  CurrentUser,
  EmailConfig,
  ServiceResponse,
  TokenPair,
} from '../types/common.type';
import { UserProviderType } from '../types/enums';
import {
  BadRequestError,
  createServiceResponse,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
  VAL_ERRORS,
  ValidationError,
} from '../utils/errors.util';
import { changePasswordHtml, renderPage } from '../utils/templates.util';
import {
  decodeAppleToken,
  generateTempPassword,
  verifyGoogleToken,
} from '../utils/users';
import {
  AdminChangePasswordSchema,
  ChangePasswordSchema,
} from '../validation/schemas';

import { BaseService } from './base.service';
import { EmailService } from './email.service';
import { PermissionService } from './permission.service';

// ============= INTERFACES =============

export interface LoginInput {
  emailOrNickname: string;
  password: string;
}

export interface LoginWithCompanyInput {
  emailOrNickname: string;
  password: string;
  companyId: string;
}

export interface GoogleLoginInput {
  id_token: string;
}

export interface AppleLoginInput {
  idToken: string;
  /** JSON stringified AppleAuthentication.AppleAuthenticationFullName — only present on first login */
  user?: string;
}

export interface SelectCompanyInput {
  userId: string;
  companyId: string;
}

export interface UpdatePasswordInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

// ============= AUTH SERVICE =============
/**
 * Service para manejar operaciones de usuarios
 *
 * @remarks
 * Este servicio maneja autenticación, generación de Tokens
 * para la entidad User. Login por OAuth.
 *
 * @example
 * ```typescript
 * const user = await login(loginInput);
 * ```
 */
export class AuthService extends BaseService {
  private readonly permissionService: PermissionService;
  private readonly emailService: EmailService;
  private readonly jwtSecret: string;
  private readonly accessTokenExpiry: jwt.SignOptions['expiresIn'] = '1d';
  private readonly refreshTokenExpiry: number = 30 * 24 * 60 * 60 * 1000;

  constructor(em: EntityManager) {
    super(em);
    this.permissionService = new PermissionService(em);
    this.emailService = this.emailService = EmailService.getInstance();

    this.jwtSecret = process.env.JWT_SECRET!;

    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET is not defined in environment variables');
    }
  }

  /**
   * Login inicial - devuelve empresas si el usuario pertenece a más de una
   */
  async login(input: LoginInput): Promise<ServiceResponse> {
    const { emailOrNickname, password } = input;

    const user = await this.findUserByEmailOrNickname(emailOrNickname, [
      'password',
      'companies',
      'companies.companyConfig',
    ]);

    if (!user) {
      throw new ValidationError('Invalid email/nickname or password');
    }

    const isMatch = await user.checkPassword(password);
    if (!isMatch) {
      throw new ValidationError('Invalid email/nickname or password');
    }

    const companies = user.companies.getItems();

    // Si el usuario no tiene empresas (puede logearse sin empresa)
    // if (companies.length === 0) {
    //   throw new ValidationError('User has no associated companies');
    // }

    // Si tiene solo una empresa, hacer login completo automáticamente
    // if (companies.length === 1) {
    //   const data = await this.loginWithCompany({
    //     emailOrNickname,
    //     password,
    //     companyId: companies[0].id,
    //   });
    // }

    if (!user.activeCompanyId && companies.length > 0) {
      //si el usuario tiene empresas pero no esta activo en ninguna, se activa en la primera
      //(este caso en realidad nunca puede pasar, pero con los mocks de los seeders si pasa)
      user.activeCompanyId = companies[0].id;
      this.em.persist(user);
      await this.em.flush();
    }

    // Si tiene múltiples empresas, devolver lista para que seleccione
    const tokens: TokenPair = await this.createTokensPair(user);
    const data = {
      user,
      companies,
      tokens,
    };

    const activeCompany = companies.find(c => c.id === user.activeCompanyId);

    // si tiene empresa hace login con permisos, si no login normal
    return activeCompany
      ? await this.buildAuthResponseWithPermissions(
          user,
          activeCompany,
          'Login successful'
        )
      : createServiceResponse(200, 'logging successfully', true, data);
  }

  /**
   * Login con empresa específica - incluye permisos
   */
  async loginWithCompany(
    input: LoginWithCompanyInput
  ): Promise<ServiceResponse> {
    const { emailOrNickname, password, companyId } = input;

    const user = await this.findUserByEmailOrNickname(emailOrNickname, [
      'password',
      'companies',
    ]);

    if (!user) {
      throw new BadRequestError('Invalid email/nickname or password');
    }

    const isMatch = await user.checkPassword(password);
    if (!isMatch) {
      throw new BadRequestError('Invalid email/nickname or password');
    }

    // Validar acceso a la empresa
    const company = await this.validateCompanyAccess(user, companyId);
    if (!company) {
      throw new ForbiddenError('User does not belong to this company');
    }

    // Construir respuesta con permisos y tokens
    return await this.buildAuthResponseWithPermissions(
      user,
      company,
      'Login successful'
    );
  }

  /**
   * Seleccionar empresa después del login inicial
   */
  async selectCompany(input: SelectCompanyInput): Promise<ServiceResponse> {
    const { userId, companyId } = input;
    const user = await this.em.findOne(
      User,
      { id: userId },
      {
        populate: ['companies'],
      }
    );

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Validar acceso a la empresa
    const company = await this.validateCompanyAccess(user, companyId);
    if (!company) {
      throw new ForbiddenError('User does not belong to this company');
    }

    // Construir respuesta con permisos y tokens
    return await this.buildAuthResponseWithPermissions(
      user,
      company,
      'Company selected successfully'
    );
  }

  /**
   * Login con Google
   */
  async loginWithGoogle(input: GoogleLoginInput): Promise<ServiceResponse> {
    const { id_token } = input;

    const googleData = await verifyGoogleToken(id_token);

    if (!googleData) {
      throw new UnauthorizedError('Invalid Google token');
    }

    const { email, name } = googleData;

    // Buscar o crear usuario
    const { user, isNewUser } = await this.findOrCreateGoogleUser(
      email || 'rafa@.mail.com',
      name
    );

    const companies = user.companies.getItems();

    // Si no tiene empresas
    if (companies.length === 0) {
      const tokens = await this.createTokensPair(user);

      return createServiceResponse(
        200,
        'User logged in but has no companies',
        true,
        {
          user,
          companies: [],
          tokens,
          isNewUser,
        }
      );
    }

    if (!user.activeCompanyId && companies.length > 0) {
      //si el usuario tiene empresas pero no esta activo en ninguna, se activa en la primera
      //(este caso en realidad nunca puede pasar, pero con los mocks de los seeders si pasa)
      user.activeCompanyId = companies[0].id;
      this.em.persist(user);
      await this.em.flush();
    }

    // Si tiene múltiples empresas, devolver lista para que seleccione
    const tokens: TokenPair = await this.createTokensPair(user);
    const data = {
      user,
      companies,
      tokens,
      isNewUser,
    };

    const activeCompany = companies.find(c => c.id === user.activeCompanyId);

    // si tiene empresa hace login con permisos, si no login normal
    return activeCompany
      ? await this.buildAuthResponseWithPermissions(
          user,
          activeCompany,
          'Login successful'
        )
      : createServiceResponse(200, 'logging successfully', true, data);
  }

  /**
   * Login con Apple
   */
  async loginWithApple(input: AppleLoginInput): Promise<ServiceResponse> {
    const { idToken, user: userJson } = input;

    const appleData = decodeAppleToken(idToken);
    if (!appleData) {
      throw new UnauthorizedError('Invalid Apple token');
    }

    const { appleId, email } = appleData;

    // fullName solo llega en el primer login — parsearlo si viene
    let name: string | undefined;
    let surname: string | undefined;
    if (userJson) {
      try {
        const fullName = JSON.parse(userJson);
        name = fullName.givenName ?? undefined;
        surname = fullName.familyName ?? undefined;
      } catch {
        // userJson malformado — ignorar
      }
    }

    const { user, isNewUser } = await this.findOrCreateAppleUser({
      appleId,
      email,
      name,
      surname,
    });
    const companies = user.companies.getItems();

    if (companies.length === 0) {
      const tokens = await this.createTokensPair(user);
      return createServiceResponse(
        200,
        'User logged in but has no companies',
        true,
        {
          user,
          companies: [],
          tokens,
          isNewUser,
        }
      );
    }

    if (!user.activeCompanyId && companies.length > 0) {
      user.activeCompanyId = companies[0].id;
      this.em.persist(user);
      await this.em.flush();
    }

    const activeCompany = companies.find(c => c.id === user.activeCompanyId);

    return activeCompany
      ? await this.buildAuthResponseWithPermissions(
          user,
          activeCompany,
          'Login successful'
        )
      : createServiceResponse(200, 'logging successfully', true, {
          user,
          companies,
          tokens: await this.createTokensPair(user),
        });
  }

  /**
   * Login con ID (para testing/desarrollo)
   */
  async loginWithId(userId: string): Promise<ServiceResponse> {
    const user = await this.em.findOne(
      User,
      { id: userId },
      {
        populate: ['companies'],
      }
    );

    if (!user) {
      throw new NotFoundError('User');
    }

    return await this.login({
      emailOrNickname: user.email || 'rafa@mail.com',
      password: process.env.DEFAULT_PASSWORD || '123456',
    });
  }

  /**
   * Olvidé mi contraseña
   */
  async forgotPassword(email: string): Promise<ServiceResponse> {
    const user = await this.em.findOne(User, { email });

    if (!user) {
      throw new NotFoundError('User');
    }

    const resetToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET || '', {
      expiresIn: '30m',
    });

    console.log(`Reset token for ${email}: ${resetToken}`);

    return createServiceResponse(200, 'Password reset email sent', true);
  }

  /**
   * Actualizar contraseña
   */
  async updatePassword(
    userId: string,
    input: UpdatePasswordInput
  ): Promise<ServiceResponse> {
    const { currentPassword, newPassword, confirmPassword } = input;

    // Validar con Zod
    ChangePasswordSchema.parse({
      currentPassword,
      newPassword,
      confirmPassword,
    });

    const user = await this.em.findOne(
      User,
      { id: userId },
      { populate: ['password'], filters: false }
    );

    if (!user) {
      throw new NotFoundError('User');
    }

    const passwordCorrect = await bcrypt.compare(
      currentPassword,
      user.password || ''
    );

    if (!passwordCorrect) {
      throw new ValidationError(VAL_ERRORS.INCORRECT_PASSWORD);
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await this.em.flush();

    return createServiceResponse(200, 'Password changed successfully', true);
  }

  /**
   * Actualizar la contraseña de otro usuario (solo super admin)
   */
  async adminUpdatePassword(
    currentUser: CurrentUser,
    input: { userId: string; newPassword: string; confirmPassword: string }
  ): Promise<ServiceResponse> {
    if (!currentUser?.isSuperAdmin) {
      throw new ForbiddenError('SuperAdmin access required');
    }

    const { userId, newPassword, confirmPassword } = input;

    AdminChangePasswordSchema.parse({ newPassword, confirmPassword });

    const user = await this.em.findOne(
      User,
      { id: userId },
      { filters: false }
    );

    if (!user) {
      throw new NotFoundError('User');
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await this.em.flush();

    return createServiceResponse(200, 'Password changed successfully', true);
  }

  /**
   * Enviar email para cambio de contraseña
   */
  async sendChangePasswordEmail(email: string): Promise<ServiceResponse> {
    const tmpPassword = generateTempPassword(6);

    const payload = {
      email: email,
      purpose: 'reset-password',
      password: tmpPassword,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET || '', {
      expiresIn: '30m',
    });

    const config: EmailConfig = {
      from: process.env.GMAIL_USER || '',
      to: email,
      subject: 'Change your password',
      html: changePasswordHtml(token, tmpPassword),
    };

    await this.emailService.sendEmail(config);

    return createServiceResponse(200, 'Change password email sent', true);
  }

  /**
   * Obtener usuario actual con todas sus empresas y permisos
   */
  async getCurrentUser(userId: string): Promise<ServiceResponse> {
    const user = await this.em.findOne(
      User,
      { id: userId },
      {
        populate: ['companies'],
      }
    );

    if (!user) {
      throw new NotFoundError('User');
    }

    const companiesWithPermissions =
      await this.permissionService.getUserCompaniesWithPermissions(userId);

    return createServiceResponse(200, 'User was fetched successfully', true, {
      id: user.id,
      email: user.email,
      name: user.name,
      surname: user.surname,
      nickname: user.nickname,
      activeCompanyId: user.activeCompanyId,
      companies: companiesWithPermissions,
    });
  }

  // ============= MÉTODOS PRIVADOS HELPER (ELIMINAN DUPLICACIÓN) =============

  public generateAccessToken(payload: string | Record<string, any>): string {
    // Si el payload es un string (userId), crear objeto con estructura básica
    const tokenPayload =
      typeof payload === 'string' ? { id: payload, userId: payload } : payload;

    return jwt.sign(tokenPayload, this.jwtSecret, {
      expiresIn: this.accessTokenExpiry,
    });
  }

  /**
   * Generar refresh token y persistirlo en la base de datos
   * @param user - Usuario para el cual generar el refresh token
   * @returns El string del refresh token generado
   */
  public async generateRefreshToken(user: User): Promise<string> {
    const tokenString = crypto.randomBytes(64).toString('hex');
    const expiresAt = moment().add(this.refreshTokenExpiry, 'ms').toDate();

    const refreshToken = this.em.create(RefreshToken, {
      user,
      token: tokenString,
      expiresAt,
    });

    this.em.persist(refreshToken);
    await this.em.flush();

    return tokenString;
  }

  /**
   * Crear par de tokens (access + refresh)
   */
  /**
   * Crear par de tokens (access + refresh) - MÉTODO PRINCIPAL UNIFICADO
   * @param user - Usuario para el cual generar los tokens
   * @param includePermissions - Si incluir permisos en el access token
   * @param companyId - ID de la empresa para incluir en el token
   * @param permissionNames - Lista de permisos para incluir en el token
   */
  async createTokensPair(
    user: User,
    includePermissions: boolean = false,
    companyId?: string,
    permissionNames?: string[]
  ): Promise<TokenPair> {
    // Construir payload del access token
    const tokenPayload: any = {
      id: user.id,
      userId: user.id,
      email: user.email,
    };

    // Agregar permisos si se solicitan
    if (includePermissions && companyId && permissionNames) {
      tokenPayload.companyId = companyId;
      tokenPayload.permissions = permissionNames;
    }

    // Generar ambos tokens usando los métodos reutilizables
    const token = this.generateAccessToken(tokenPayload);
    const refreshToken = await this.generateRefreshToken(user);

    return {
      token,
      refreshToken,
    };
  }

  /**
   * Generate email verification token
   */
  public generateEmailVerificationToken(email: string): string {
    return jwt.sign({ id: email }, this.jwtSecret, {
      expiresIn: '30d',
    });
  }

  /**
   * Generate company verification token
   */
  public generateCompanyVerificationToken(companyId: string): string {
    return jwt.sign({ id: companyId }, this.jwtSecret, {
      expiresIn: '30d',
    });
  }

  /**
   * Verify JWT token
   */
  public verifyToken(token: string): { id: string } {
    try {
      return jwt.verify(token, this.jwtSecret) as { id: string };
    } catch (error: any) {
      throw new UnauthorizedError(`Invalid or expired token ${error.message}`);
    }
  }

  /**
   * Validate refresh token and generate new access token
   */
  public async refreshAccessToken(
    inputToken: string
  ): Promise<ServiceResponse> {
    if (!inputToken) {
      throw new ValidationError('Refresh token is required');
    }

    const storedRefreshToken = await this.em.findOne(
      RefreshToken,
      { token: inputToken },
      { populate: ['user'], filters: { companyContext: false } }
    );

    if (!storedRefreshToken) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    if (moment(storedRefreshToken.expiresAt).isBefore(moment())) {
      this.em.remove(storedRefreshToken);
      await this.em.flush();
      throw new UnauthorizedError('Refresh token expired');
    }

    const { user } = storedRefreshToken;

    // Si le quedan menos de 7 días de validez, extendemos el token
    const daysUntilExpiry = moment(storedRefreshToken.expiresAt).diff(
      moment(),
      'days'
    );
    if (daysUntilExpiry < 7) {
      storedRefreshToken.expiresAt = moment()
        .add(this.refreshTokenExpiry, 'ms')
        .toDate();
      this.em.persist(storedRefreshToken);
      await this.em.flush();
    }

    // Generar un nuevo accessToken limpio (sin permisos)
    const token = this.generateAccessToken(user.id);

    return createServiceResponse(200, 'Token refreshed successfully', true, {
      tokens: {
        token,
        refreshToken: storedRefreshToken.token,
      },
    });
  }

  // ============= TOKEN VERIFICATION & MANAGEMENT =============

  /**
   * Revoke refresh token
   */
  public async revokeRefreshToken(tokenString: string): Promise<void> {
    const refreshToken = await this.em.findOne(RefreshToken, {
      token: tokenString,
    });

    if (refreshToken) {
      this.em.remove(refreshToken);
      await this.em.flush();
    }
  }

  /**
   * Revoke all user refresh tokens
   */
  public async revokeAllUserTokens(userId: string): Promise<void> {
    const tokens = await this.em.find(RefreshToken, { user: userId });
    this.em.remove(tokens);
    await this.em.flush();
  }

  /**
   * Eliminar todos los refresh tokens caducados de la base de datos
   */
  public async cleanExpiredRefreshTokens(): Promise<number> {
    const deletedCount = await this.em.nativeDelete(RefreshToken, {
      expiresAt: { $lt: moment().toDate() },
    });
    return deletedCount;
  }

  /**
   * Construir respuesta de autenticación completa con permisos
   */
  public async buildAuthResponseWithPermissions(
    user: User,
    company: Company,
    message: string
  ): Promise<ServiceResponse> {
    // Obtener permisos del usuario en esta empresa
    const permissionsContext =
      await this.permissionService.getLoginPermissionsContext(user, company.id);

    // Crear tokens con permisos incluidos
    const tokens = await this.createTokensPair(
      user,
      true,
      company.id,
      permissionsContext.permissionNames
    );

    // Actualizar empresa activa
    user.activeCompanyId = company.id;
    await this.em.flush();

    // Agregar permisos y subscription al objeto user para retrocompatibilidad
    Object.assign(user, {
      subscription: {
        hasActive: permissionsContext.hasActiveSubscription,
        subscriptionState: permissionsContext.subscriptionState,
        planName: permissionsContext.plan?.name || null,
        status: permissionsContext.subscriptionStatus,
        isInTrial: permissionsContext.isInTrial || false,
        trialEndsAt: permissionsContext.trialEndsAt || null,
        startDate: permissionsContext.startDate || null,
        endDate: permissionsContext.endDate || null,
        cancelAtPeriodEnd: permissionsContext.cancelAtPeriodEnd ?? null,
        renewsAt: permissionsContext.renewsAt ?? null,
        remainingCredits: permissionsContext.remainingCredits ?? null,
        creditsTotal: permissionsContext.creditsTotal ?? null,
      },
      permissions: permissionsContext.permissionNames,
    });

    return createServiceResponse(200, message, true, {
      user,
      company,
      tokens,
      subscription: {
        hasActive: permissionsContext.hasActiveSubscription,
        subscriptionState: permissionsContext.subscriptionState,
        planName: permissionsContext.plan?.name || null,
        status: permissionsContext.subscriptionStatus,
        isInTrial: permissionsContext.isInTrial || false,
        trialEndsAt: permissionsContext.trialEndsAt || null,
        startDate: permissionsContext.startDate || null,
        endDate: permissionsContext.endDate || null,
        cancelAtPeriodEnd: permissionsContext.cancelAtPeriodEnd ?? null,
        renewsAt: permissionsContext.renewsAt ?? null,
        remainingCredits: permissionsContext.remainingCredits ?? null,
        creditsTotal: permissionsContext.creditsTotal ?? null,
      },
      permissions: permissionsContext.permissionNames,
    });
  }

  public async resetRandomPassword(token: string): Promise<string> {
    try {
      const decodedToken = jwt.verify(token, this.jwtSecret) as {
        id: string;
        email: string;
        password: string;
      };

      const user = await this.em.findOne(
        User,
        { email: decodedToken.email },
        { filters: false }
      );

      if (!user) {
        return renderPage(
          'Cambio de contraseña fallido',
          'Usuario no encontrado',
          false
        );
      }

      const saltRounds = 10;
      user.password = await bcrypt.hash(decodedToken.password, saltRounds); // Aseguramos que la contraseña se hashee correctamente
      this.em.persist(user);
      await this.em.flush();

      return renderPage(
        '¡Cambio de contraseña completado!',
        'Podrás iniciar sesión con tu nueva contraseña temporal. Por favor, cámbiala en los ajustes de tu cuenta.',
        true
      );
    } catch (err: any) {
      return renderPage(
        'Verificación fallida',
        `Token inválido o caducado. ${err.message}`,
        false
      );
    }
  }

  /**
   * Buscar usuario por email o nickname
   */
  private async findUserByEmailOrNickname(
    emailOrNickname: string,
    populate: string[] = []
  ): Promise<User | null> {
    return await this.em.findOne(
      User,
      {
        $or: [{ email: emailOrNickname }, { nickname: emailOrNickname }],
      },
      {
        populate: populate as any,
        filters: false,
      } as const
    );
  }

  /**
   * Buscar o crear usuario de Apple.
   * Lookup order: appleId → email → create new
   */
  private async findOrCreateAppleUser({
    appleId,
    email,
    name,
    surname,
  }: {
    appleId: string;
    email?: string;
    name?: string;
    surname?: string;
  }): Promise<{ user: User; isNewUser: boolean }> {
    let isNewUser = false;
    const populate = ['companies', 'companies.companyConfig'] as const;

    // 1. Buscar por appleId (logins posteriores al primero)
    let user = await this.em.findOne(
      User,
      { appleId },
      { populate, filters: false }
    );

    // 2. Buscar por email (el usuario puede venir de registro normal o Google)
    if (!user && email) {
      user = await this.em.findOne(
        User,
        { email },
        { populate, filters: false }
      );
      if (user) {
        // Vincular cuenta Apple al usuario existente
        user.appleId = appleId;
        if (name && !user.name) user.name = name;
        if (surname && !user.surname) user.surname = surname;
        await this.em.flush();
      }
    }

    // 3. Crear usuario nuevo
    if (!user) {
      isNewUser = true;
      const nickname = email
        ? email.split('@')[0]
        : appleId.replace('.', '').slice(0, 12);

      const newUser = this.em.create(User, {
        email: email ?? `${appleId}@privaterelay.appleid.com`,
        name,
        surname,
        nickname,
        provider: UserProviderType.APPLE,
        appleId,
        isActive: true,
        isBlocked: false,
        isVerified: true,
      });
      this.em.persist(newUser);
      await this.em.flush();

      user = await this.em.findOne(
        User,
        { appleId },
        { populate, filters: false }
      );
      if (!user) throw new InternalServerError('Failed to create Apple user');
    } else if (name || surname) {
      // Primer login de un usuario ya existente — actualizar nombre si llegó
      if (name && !user.name) user.name = name;
      if (surname && !user.surname) user.surname = surname;
      await this.em.flush();
    }

    return {
      user,
      isNewUser,
    };
  }

  /**
   * Buscar o crear usuario de Google
   */
  private async findOrCreateGoogleUser(
    email: string,
    name?: string
  ): Promise<{ user: User; isNewUser: boolean }> {
    let isNewUser = false;
    let user = await this.em.findOne(
      User,
      { email },
      { populate: ['companies', 'companies.companyConfig'], filters: false }
    );

    if (!user) {
      isNewUser = true;
      const newUser = this.em.create(User, {
        email,
        name,
        nickname: email.split('@')[0],
        provider: UserProviderType.GOOGLE,
        isActive: true,
        isBlocked: false,
        isVerified: true,
        fullName: name || '',
      });
      this.em.persist(newUser);
      await this.em.flush();

      // Volver a buscar para tener las relaciones cargadas
      user = await this.em.findOne(
        User,
        { email },
        { populate: ['companies'], filters: false }
      );

      if (!user) {
        throw new InternalServerError('Failed to create user');
      }
    }

    return { user, isNewUser };
  }

  /**
   * Validar que el usuario tiene acceso a la empresa
   */
  private async validateCompanyAccess(
    user: User,
    companyId: string
  ): Promise<Company | null> {
    const belongsToCompany = user.companies
      .getItems()
      .some(c => c.id === companyId);

    if (!belongsToCompany) {
      return null;
    }

    const company = await this.em.findOne(
      Company,
      { id: companyId },
      { filters: false }
    );

    if (!company) {
      return null;
    }

    return company;
  }
}
