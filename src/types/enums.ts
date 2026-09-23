export enum Durations {
  ONE_HOUR = '1 hora',
  ONE_DAY = '1 dia',
  ONE_WEEK = '1 semana',
  ONE_MONTH = '1 mes',
}

export enum UserProviderType {
  GOOGLE = 'google',
  APPLE = 'apple',
  FACEBOOK = 'facebook',
  LOCAL = 'local',
}

export enum NotificationType {
  MESSAGE = 'message',
  WARNING = 'warning',
  ERROR = 'error',
  INFO = 'info',
}

export enum PaymentType {
  MENSUAL = 'mensual',
  ANUAL = 'anual',
}

/**
 * Motivo por el que el llamante no puede inscribirse en un Restricted Schedule.
 * Cubre **solo** la restricción de planes: nunca aforo, créditos ni ventana de
 * reserva anticipada. Ver ADR 0005.
 */
export enum SchedulePlanAccessReason {
  /** El schedule restringe planes y el llamante no tiene suscripción vigente. */
  NO_LIVE_SUBSCRIPTION = 'NO_LIVE_SUBSCRIPTION',
  /** Tiene suscripción vigente, pero a un plan que el schedule no admite. */
  PLAN_NOT_ALLOWED = 'PLAN_NOT_ALLOWED',
}

export enum ScheduleState {
  AVAILABLE = 'available',
  CANCELLED = 'cancelled',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
  PENDING = 'pending',
}

export enum CreditCardType {
  CREDIT = 'credit',
  DEBIT = 'debit',
}

export enum CreditCardProvider {
  VISA = 'visa',
  MASTERCARD = 'mastercard',
}

export enum PaymentMethodType {
  CREDIT_CARD = 'credit_card',
  APPLE_PAY = 'apple_pay',
  GOOGLE_PAY = 'google_pay',
}

export enum Currency {
  EUR = 'eur',
  USD = 'usd',
}

export enum TransactionStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  PENDING = 'PENDING',
  REFUND = 'REFUND',
}

export enum PaymentMethodStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  EXPIRED = 'expired',
}

export enum ScheduleType {
  STANDARD = 'standard',
  SPARRING = 'sparring',
  FREE = 'free',
  CONDITIONING = 'conditioning',
  COMPETITION = 'competition',
}

export enum UserRoleEnum {
  STANDARD = 'standard',
  ADMIN = 'admin',
  COACH = 'coach',
}
