export const graphqlMutations = `
type Mutation {
    # ── User ──────────────────────────────────────────────────────────
    setActiveCompany(companyId: ID!): MeResponse
    createUser(user: CreateUserInput!, company: CreateCompanyInput): LoginResponse
    createCompanyMember(user: CreateCompanyMemberInput!): UserResponse!
    updateUser(user: UpdateUserInput!): UserResponse!
    forgotPassword(email: String!): String!
    updatePassword(password: UpdatePasswordInput!): UserResponse!
    adminUpdatePassword(password: AdminUpdatePasswordInput!): UserResponse!
    updateUserPicture(picture: String!, userId: String!): UserResponse!
    deleteUser(id: ID!): DefaultResponse!
    loginWithGoogle(id_token: String!): LoginResponse!
    loginWithApple(idToken: String!, user: String): LoginResponse!
    sendChangePasswordEmail(email: String!): DefaultResponse!
    sendTestNotification: DefaultResponse!

    # ── Permission ────────────────────────────────────────────────────
    syncPermissions: DefaultResponse!

    # ── Message ───────────────────────────────────────────────────────
    createMessage(message: CreateMessageInput!): MessageResponse!
    fixMessage(messageId: ID!, fixedEndDate: String!): MessageResponse!
    unfixMessage(messageId: ID!): MessageResponse!

    # ── Schedule ──────────────────────────────────────────────────────
    removeSchedule(scheduleId: ID!): ScheduleResponse!
    createSchedule(schedule: CreateScheduleInput!): ScheduleResponse!
    changeScheduleStatus(scheduleId: ID!, status: ScheduleState!, reason: String): ScheduleResponse!
    createScheduleDevelopment(scheduleDevelopment: CreateScheduleDevelopmentInput!): ScheduleResponse!
    addUserToSchedule(scheduleId: ID!): ScheduleResponse!
    removeUserFromSchedule(scheduleId: ID!, userId: ID): ScheduleResponse!
    updateScheduleOptions(scheduleOptions: UpdateScheduleOptionsInput!): ScheduleOptionsResponse!
    updateSchedule(schedule: UpdateScheduleInput!): ScheduleResponse!
    updateScheduleProgrammed(scheduleProgrammed: UpdateScheduleProgrammedInput!): ScheduleProgrammedResponse!
    deleteScheduleProgrammed(ids: [ID]!): ScheduleProgrammedResponse!

    # ── Poll ──────────────────────────────────────────────────────────
    createPoll(poll: CreatePollInput!): PollResponse!
    createOrChangePollVote(vote: CreatePollVoteInput!): PollResponse!
    deletePollVote(pollId: ID!): PollResponse!
    removePolls(ids: [String]!): PollResponse!

    # ── Rating ────────────────────────────────────────────────────────
    createOrUpdateRating(rating: CreateOrUpdateRatingInput!): RatingResponse!
    deleteRating: RatingResponse!

    # ── Plan ──────────────────────────────────────────────────────────
    createPlan(plan: CreatePlanInput!): PlanResponse!
    updatePlan(plan: UpdatePlanInput!): PlanResponse!
    removePlan(planId: ID!): PlanResponse!
    archivePlan(planId: ID!): PlanResponse!

    # ── Customer ──────────────────────────────────────────────────────
    createCustomer(customer: CreateCustomerInput!): CustomerResponse!
    updateCustomer(customer: UpdateCustomerInput!): CustomerResponse!
    deactivateCustomer(customerId: ID!): CustomerResponse!

    # ── PaymentMethod ─────────────────────────────────────────────────
    removePaymentMethod(paymentMethodId: ID!): PaymentMethodResponse!
    setDefaultPaymentMethod(paymentMethodId: ID!): PaymentMethodResponse!
    updatePaymentMethodMetadata(paymentMethodId: ID!, metadata: JSON): PaymentMethodResponse!
    markPaymentMethodAsExpired(paymentMethodId: ID!): PaymentMethodResponse!
    cleanupExpiredPaymentMethods(customerId: ID!): PaymentMethodResponse!
    validatePaymentMethod(paymentMethodId: ID!): PaymentMethodResponse!

    # ── Pagos ─────────────────────────────────────────────────────────
    addPaymentMethod(nonce: String!, setAsDefault: Boolean, verifyCard: Boolean, companyId: ID): PaymentMethodResponse!
    confirmPaymentMethodFromSetupIntent(setupIntentId: String!, setAsDefault: Boolean, companyId: ID): PaymentMethodResponse!
    getPaymentOAuthUrl(companyId: ID!, platform: String): PaymentOAuthUrlResponse!
    getPaymentOnboardingUrl(companyId: ID!, platform: String): PaymentOAuthUrlResponse!
    disconnectPaymentAccount(companyId: ID!): PaymentConnectionStatusResponse!
    
    tokenizeCard(
      cardNumber: String!
      expirationMonth: String!
      expirationYear: String!
      cvv: String!
      cardholderName: String
    ): TokenizeCardResponse!

    # ── Subscription — usuario ────────────────────────────────────────
    createSubscription(subscription: CreateSubscriptionInput!): SubscriptionResponse!
    """Cambio de plan con prorrateo opcional. Usar en lugar de updateSubscription para cambios de plan."""
    changePlan(input: ChangePlanInput!): SubscriptionResponse!
    updateSubscription(subscription: UpdateSubscriptionInput!): SubscriptionResponse!
    """
    Cancela una suscripcion SIEMPRE de forma diferida: surte efecto al final
    del periodo ya pagado (el CRON de billing hace la transicion real a
    CANCELED). El miembro conserva el acceso durante el periodo que pago. El
    campo cancelAtPeriodEnd del input esta obsoleto y se ignora. Para la
    terminacion inmediata (solo admin) usar radicalCancelSubscription. Ver ADR 0003.
    """
    cancelSubscription(input: CancelSubscriptionInput!): SubscriptionResponse!
    pauseSubscription(subscriptionId: ID!): SubscriptionResponse!
    resumeSubscription(subscriptionId: ID!): SubscriptionResponse!
    reactivateSubscription(subscriptionId: ID!): SubscriptionResponse!
    updatePaymentMethodAndRetry(subscriptionId: ID!, paymentMethodId: ID!): SubscriptionResponse!

    # ── Subscription — admin ───────────────────────────────────────────
    """
    Cancelacion RADICAL (inmediata) — solo admin. Trunca el periodo pagado:
    status=CANCELED con canceledAt/endedAt/currentPeriodEnd = ahora y sin
    nextBillingDate. El miembro pierde los dias restantes. Requiere motivo. Ver ADR 0003.
    """
    radicalCancelSubscription(input: RadicalCancelSubscriptionInput!): SubscriptionResponse!
    adminOverrideSubscription(input: AdminOverrideSubscriptionInput!): SubscriptionResponse!
    forceRenewal(subscriptionId: ID!): SubscriptionResponse!
    extendSubscriptionPeriod(subscriptionId: ID!, days: Int!, reason: String!): SubscriptionResponse!
    applySubscriptionCredit(subscriptionId: ID!, amountInCents: Int!, reason: String!): SubscriptionResponse!
    """
    Ajuste manual auditado de Session Credits (solo admin, mismo permiso que
    radicalCancelSubscription). Mueve creditsTotal en delta (positivo o
    negativo, distinto de 0) con motivo obligatorio; queda en el historial como
    credit_adjusted. Se rechaza sobre suscripciones ilimitadas o cerradas y si
    el resultado dejaria creditsUsed > creditsTotal o creditsTotal < 0.
    """
    adjustSessionCredits(subscriptionId: ID!, delta: Int!, reason: String!): SubscriptionResponse!

    # ── Invoice ───────────────────────────────────────────────────────
    voidInvoice(invoiceId: ID!): InvoiceResponse!
    markInvoiceAsUncollectible(invoiceId: ID!): InvoiceResponse!

    # ── Transaction ───────────────────────────────────────────────────
    createCharge(input: CreateChargeInput!): TransactionResponse!
    refundTransaction(input: RefundTransactionInput!): TransactionResponse!
    retryFailedTransaction(transactionId: ID!): TransactionResponse!
    markTransactionAsReconciled(transactionId: ID!, reconciledBy: String): TransactionResponse!

    # ── TrainingTask ──────────────────────────────────────────────────
    createTrainingTask(trainingTask: CreateTrainingTaskInput!): TrainingTaskResponse!
    removeTrainingTasks(ids: [ID]!): TrainingTaskResponse!

    # ── UserWeight ────────────────────────────────────────────────────
    addUserWeight(userWeight: AddUserWeightInput!): UserWeightResponse!
    removeUserWeights(ids: [ID]!): UserWeightResponse!

    # ── Product ───────────────────────────────────────────────────────
    createProduct(product: CreateProductInput!): ProductResponse!
    updateProductPicture(imageName: String!, productId: String!): ProductResponse!
    removeProduct(ids: [String]!): ProductResponse!

    # ── Promotion ─────────────────────────────────────────────────────
    createPromotion(promotion: CreatePromotionInput!): PromotionResponse!
    updatePromotion(id: ID!, promotion: UpdatePromotionInput!): PromotionResponse!
    deletePromotion(id: ID!): PromotionResponse!

    # ── Token / Push ──────────────────────────────────────────────────
    registerToken(token: String!): RegisterTokenResponse!
    removePushToken(token: String!): DefaultResponse!
    sendNotification(notification: SendNotificationInput!): SendNotificationResponse!
    refreshAccessToken(inputToken: String!): LoginResponse!
    markNotificationAsRead(id: ID!): NotificationResponse!
    markAllNotificationsAsRead: DefaultResponse!
    
    # ── Company ───────────────────────────────────────────────────────
    updateCompany(companyId: ID!, companyData: CompanyDataInput!, scheduleOptions: ScheduleOptionsInput!): CompanyResponse!
    updateCompanyLogo(companyId: ID!, picture: String!): CompanyResponse!
    createCompany(company: CreateCompanyInput!): MeResponse!
    requestJoinCompany(companyId: ID, companyCode: String): DefaultResponse!
    admitUserToCompany(companyId: ID!, userId: ID!, role: UserRoleEnum): DefaultResponse!
}
`;
