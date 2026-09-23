import { GraphQLError } from 'graphql';

import { ServiceResponse } from '../types/common.type';

export const VAL_ERRORS = {
  SCHEDULE_NOT_AVAILABLE: 'Schedule is not available for booking',
  SCHEDULE_ALREADY_PASSED: 'Schedule has already passed',
  SCHEDULE_FULL: 'Schedule is full',
  MAX_ACTIVE_RESERVATIONS_REACHED: 'Maximum active reservations reached',
  SAME_DAY_BOOKING_NOT_ALLOWED: 'Booking for the same day is not permitted',
  ADVANCE_BOOKING_OUTSIDE_WINDOW:
    'Schedule is outside the advance booking window',
  USER_ALREADY_IN_SCHEDULE: 'User is already registered for this schedule',
  PLAN_NOT_ALLOWED_IN_SCHEDULE:
    'Your current plan does not allow registering for this schedule',
  PLAN_RESTRICTION_NOT_SUPPORTED_ON_REPEAT:
    'A plan restriction cannot be set on a repeating schedule yet; create it and then restrict each schedule',
  PLAN_NOT_IN_COMPANY:
    'One or more of the selected plans do not belong to this company',
  INCORRECT_PASSWORD: 'Current password is incorrect',
  SCHEDULE_HAS_USERS:
    'Cannot delete schedule because it has registered or waitlisted users',
  MAX_USERS_BELOW_CURRENT:
    'Maximum users cannot be less than the number of registered users',
  START_DATE_MUST_BE_BEFORE_END_DATE: 'startDate must be before endDate.',
} as const;

export const NOT_FND_ERRORS = {
  SCHEDULE: 'Schedule not found',
  USER: 'User not found',
} as const;

export const FORBIDDEN_ERRORS = {
  NOT_AUTHORIZED: 'You are not authorized to perform this action',
} as const;

export const BAD_REQUEST_ERRORS = {
  USER_LOGGED_IN_TWO_COMPANIES:
    'User is logged in two companies at the same time',
  SUBSCRIPTION_ID_REQUIRED: 'Subscription ID is required',
  QUANTITY_MUST_BE_GREATER_THAN_0: 'Quantity must be greater than 0',
  SUBSCRIPTION_NOT_ACTIVE: 'Subscription is not active',
  ONLY_ACTIVE_SUBSCRIPTIONS_CAN_BE_PAUSED:
    'Only active subscriptions can be paused',
  SUBSCRIPTION_NOT_PAUSED: 'Subscription is not paused',
  ADMIN_OVERRIDE_REASON_REQUIRED: 'A reason is required for admin overrides',
  ADMIN_OVERRIDE_NO_CHANGES: 'No changes specified in admin override',
  ADMIN_OVERRIDE_CANNOT_CANCEL:
    'adminOverride cannot cancel a subscription. Use radicalCancelSubscription for immediate termination, or cancelSubscription for deferred cancellation.',
  DAYS_MUST_BE_POSITIVE: 'Days must be a positive number',
  REASON_REQUIRED: 'A reason is required',
  CREDIT_AMOUNT_POSITIVE: 'Credit amount must be a positive number',
  CREDIT_EXCEED_PLAN:
    'Credit cannot exceed the plan amount. Use a refund instead.',
  USER_ID_REQUIRED: 'User ID is required',
  SUB_AND_PLAN_REQUIRED: 'subscriptionId and newPlanId are required',
  ONLY_ACTIVE_OR_TRIAL_CAN_CHANGE_PLAN:
    'Only active or trialing subscriptions can change plan',
  NEW_PLAN_SAME_AS_CURRENT: 'New plan is the same as the current plan',
  PRORATION_CHARGE_FAILED:
    'Proration charge failed. Plan not changed. Please check your payment method.',
  REQUIRED_FIELDS: 'userId, planId and companyId are required',
  TRIAL_PERIOD_NEGATIVE: 'Trial period days cannot be negative',
  INVALID_START_DATE: 'Invalid startDate',
  CANNOT_SCHEDULE_PLAN_CHANGE_IN_FUTURE:
    'Cannot schedule a plan change in the future',
  VALID_PM_REQUIRED_REACTIVATE:
    'A valid payment method is required to reactivate the subscription',
  PAID_PLAN_MUST_START_TODAY:
    'Paid subscriptions must start today: they can be scheduled neither in the past nor in the future',
  BACKDATED_PERIOD_ALREADY_ELAPSED:
    'Cannot backdate this subscription: the resulting period has already fully elapsed',
  FUTURE_SUBSCRIPTION_ALREADY_SCHEDULED:
    'There is already a future subscription scheduled for this user',
  SESSION_COUNT_MUST_BE_POSITIVE:
    'sessionCount must be a positive integer (or null for unlimited)',
  SESSION_PACK_CANNOT_HAVE_TRIAL:
    'A session pack (plan with sessionCount) cannot have a trial period',
  CANNOT_REACTIVATE_SESSION_PACK:
    'A session pack is single-use and cannot be reactivated. Create a new subscription instead.',
  CANNOT_CHANGE_PLAN_WITH_SESSION_PACK:
    'Plan changes into or out of a session pack are not allowed. Cancel and schedule a new subscription instead.',
} as const;

export const CONFLICT_ERRORS = {
  USER_ALREADY_ACTIVE_IN_PLAN:
    'User already has an active subscription to this plan',
  FUTURE_SUBSCRIPTION_ALREADY_SCHEDULED:
    'There is already a future subscription scheduled for this user',
  BACKDATED_OVERLAPS_EXISTING_ENTITLEMENT:
    'Cannot backdate this subscription: it overlaps an existing active entitlement for this user and company',
} as const;

export const INTERNAL_ERRORS = {
  ERROR_CALCULATING_STATS: 'Error calculating subscription stats',
} as const;

/**
 * Creates a standardized service response
 */
export const createServiceResponse = <T = any>(
  code: number,
  message: string,
  success: boolean = true,
  data?: T
): ServiceResponse<T> => {
  return {
    code,
    message,
    success,
    ...(data && { ...data }),
  };
};

/**
 * Custom application errors - Base class that extends GraphQLError
 */
export class AppError extends GraphQLError {
  public statusCode: number;
  public isOperational: boolean;

  constructor(
    message: string,
    statusCode: number,
    code: string = 'BAD_REQUEST',
    isOperational: boolean = true
  ) {
    super(message, {
      extensions: {
        code,
        http: { status: statusCode },
      },
    });

    this.statusCode = statusCode;
    this.isOperational = isOperational;

    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * 401 - Unauthorized Error (usuario no autenticado)
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Please login, token expired') {
    super(message, 401, 'UNAUTHENTICATED');
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

/**
 * 403 - Forbidden Error (usuario autenticado pero sin permisos)
 */
export class ForbiddenError extends AppError {
  constructor(message: string = FORBIDDEN_ERRORS.NOT_AUTHORIZED) {
    super(message, 403, 'FORBIDDEN');
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

/**
 * 404 - Not Found Error (recurso no encontrado)
 */
export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * 400 - Bad Request Error (petición inválida)
 */
export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400, 'BAD_REQUEST');
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

/**
 * 400 - Validation Error (error de validación)
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(`Validation Error: ${message}`, 400, 'BAD_USER_INPUT');
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * 409 - Conflict Error (conflicto de recursos, ej: email duplicado)
 */
export class ConflictError extends AppError {
  constructor(message: string = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/**
 * 500 - Internal Server Error (error interno del servidor)
 */
export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error') {
    super(message, 500, 'INTERNAL_SERVER_ERROR', false);
    Object.setPrototypeOf(this, InternalServerError.prototype);
  }
}

/**
 * 502 - Bad Gateway Error (error en API externa)
 * Usado cuando la API externa retorna un error o respuesta inválida
 */
export class ExternalAPIError extends AppError {
  constructor(
    message: string = 'External service returned an error',
    apiName?: string
  ) {
    const errorMessage = apiName
      ? `${apiName} API error: ${message}`
      : `External API error: ${message}`;
    super(errorMessage, 502, 'BAD_GATEWAY', false);
    Object.setPrototypeOf(this, ExternalAPIError.prototype);
  }
}

/**
 * 503 - Service Unavailable Error (servicio externo no disponible)
 * Usado cuando no se puede conectar a la API externa
 */
export class ServiceUnavailableError extends AppError {
  constructor(
    message: string = 'External service is currently unavailable',
    serviceName?: string
  ) {
    const errorMessage = serviceName
      ? `${serviceName} is currently unavailable: ${message}`
      : message;
    super(errorMessage, 503, 'SERVICE_UNAVAILABLE', false);
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
  }
}

/**
 * 504 - Gateway Timeout Error (timeout en API externa)
 * Usado cuando la API externa no responde en el tiempo esperado
 */
export class GatewayTimeoutError extends AppError {
  constructor(
    message: string = 'External service timeout',
    timeoutMs?: number
  ) {
    const errorMessage = timeoutMs
      ? `External service timeout after ${timeoutMs}ms: ${message}`
      : message;
    super(errorMessage, 504, 'GATEWAY_TIMEOUT', false);
    Object.setPrototypeOf(this, GatewayTimeoutError.prototype);
  }
}

/**
 * Error handler wrapper for resolvers
 * Convierte errores desconocidos a ServiceResponse
 */
export const handleError = (error: any): ServiceResponse => {
  // Si es un AppError (ya es GraphQLError), simplemente propaga
  if (error instanceof AppError || error?.isOperational) {
    throw error; // Dejar que GraphQL lo maneje
  }

  // Si es otro tipo de GraphQLError, propagar también
  if (error instanceof GraphQLError) {
    throw error;
  }

  // Error desconocido - logear y convertir a InternalServerError
  console.error('Unexpected error:', error);
  throw new InternalServerError();
};

/**
 * Wrapper para convertir ServiceResponse con error a GraphQLError
 * Útil para mantener compatibilidad con código legacy que usa ServiceResponse
 */
export const serviceResponseToError = (response: ServiceResponse): never => {
  const { code, message } = response;

  switch (code) {
    case 401:
      throw new UnauthorizedError(message);
    case 403:
      throw new ForbiddenError(message);
    case 404:
      throw new NotFoundError(message);
    case 409:
      throw new ConflictError(message);
    case 400:
      throw new BadRequestError(message);
    case 502:
      throw new ExternalAPIError(message);
    case 503:
      throw new ServiceUnavailableError(message);
    case 504:
      throw new GatewayTimeoutError(message);
    case 500:
    default:
      throw new InternalServerError(message);
  }
};

/**
 * Helper para manejar errores de fetch/axios en APIs externas
 * Convierte errores HTTP a los errores GraphQL apropiados
 */
export const handleExternalAPIError = (error: any, apiName?: string): never => {
  // Error de red (ECONNREFUSED, ENOTFOUND, etc.)
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    throw new ServiceUnavailableError(
      error.message || 'Cannot connect to external service',
      apiName
    );
  }

  // Timeout
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    throw new GatewayTimeoutError(
      error.message || 'Request timeout',
      error.timeout
    );
  }

  // Si tiene response (axios/fetch error)
  if (error.response) {
    const status = error.response.status;
    const message =
      error.response.data?.message || error.message || 'Unknown error';

    // 4xx - Error del cliente (nuestra request está mal)
    if (status >= 400 && status < 500) {
      throw new ExternalAPIError(
        `Client error (${status}): ${message}`,
        apiName
      );
    }

    // 5xx - Error del servidor externo
    if (status >= 500) {
      throw new ServiceUnavailableError(
        `Server error (${status}): ${message}`,
        apiName
      );
    }
  }

  // Error desconocido
  throw new ExternalAPIError(
    error.message || 'Unknown external API error',
    apiName
  );
};
