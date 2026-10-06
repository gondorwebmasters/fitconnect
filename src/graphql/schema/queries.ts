export const graphqlQueries = `
type Query {
    # ── Login ─────────────────────────────────────────────────────────
    login(emailOrNickname: String!, password: String!): LoginResponse!
    loginWithId(id: ID!): LoginResponse!

    # ── User ──────────────────────────────────────────────────────────
    getUsers(query: String, page: Int, roleFilter: [UserRoleEnum], stateFilter: String, filterMe: Boolean, planFilter: PlanFilterInput): UserResponse!
    me: MeResponse
    findUser(id: ID!): UserResponse!
    sendEmailVerification: DefaultResponse!

    # ── Message ───────────────────────────────────────────────────────
    getConversation(otherUserId: ID, page: Int, limit: Int, isForumMessage: Boolean): MessageResponse!
    getNotifications(limit: Int, page: Int): NotificationResponse!

    # ── Schedule ──────────────────────────────────────────────────────
    getSchedules(scheduleId: ID, schedulesIds: [ID]): ScheduleResponse!
    getScheduleOptions: ScheduleOptionsResponse!
    getSchedulesResume: ScheduleResumeResponse!
    getTodaySchedulesResume: ScheduleResumeResponse!
    getSchedulesFromToday: ScheduleResponse!
    getSchedulesRange(startDate: String!, endDate: String!, mySchedules: Boolean): ScheduleResponse!
    getSchedulesResumeRange(startDate: String!, endDate: String!): ScheduleResumeResponse!
    getSchedulesStats(month: Int!): SchedulesStatsResponse!
    getMonthlySchedules(month: Int!, startHour: String!): ScheduleResponse!
    getUserSchedules(userId: ID, past: Boolean): ScheduleResponse!
    getSchedulesProgrammed(id: ID): ScheduleProgrammedResponse!

    # ── Poll ──────────────────────────────────────────────────────────
    getPolls(pollId: ID, filter: PollFilter): PollResponse!
    getAdminPolls(id: ID): PollResponse!

    # ── Rating ────────────────────────────────────────────────────────
    getCompanyRatings(companyId: ID): RatingResponse!
    getMyRating(companyId: ID): RatingResponse!

    # ── Plan ──────────────────────────────────────────────────────────
    listPlans(onlyActive: Boolean, showGlobal: Boolean): PlanResponse!
    getPlan(planId: ID!): PlanResponse!
    getPlansByCompany(companyId: ID!): PlanResponse!

    # ── Product ───────────────────────────────────────────────────────
    getProducts: ProductResponse!

    # ── Promotion ─────────────────────────────────────────────────────
    getCompanyPromotions(includeInactive: Boolean): PromotionResponse!
    getActivePromotions: PromotionResponse!

    # ── Article ───────────────────────────────────────────────────────
    getArticles(limit: Int!, offset: Int!): ArticleResponse!

    # ── Admin ─────────────────────────────────────────────────────────
    getAdminStats: AdminStatsResponse!
    getReportMetrics: ReportMetricsResponse!

    # ── TrainingTask ──────────────────────────────────────────────────
    getTrainingTasks(userId: String, dateRange: [String]!, onlyGlobal: Boolean): TrainingTaskResponse!

    # ── UserWeight ────────────────────────────────────────────────────
    getUserWeights(userId: String, dateRange: [String]): UserWeightResponse!

    # ── S3 ────────────────────────────────────────────────────────────
    getPresignedUrl(key: String, command: String): PresignedUrlResponse!

    # ── Customer ──────────────────────────────────────────────────────
    getCustomer(customerId: ID!): CustomerResponse!
    getCustomerByUserId(userId: ID!): CustomerResponse!

    # ── PaymentMethod ─────────────────────────────────────────────────
    listUserPaymentMethods(userId: ID!): PaymentMethodResponse!
    listPaymentMethods(customerId: ID!): PaymentMethodResponse!
    getPaymentMethod(paymentMethodId: ID!): PaymentMethodResponse!
    getDefaultPaymentMethod(customerId: ID!): PaymentMethodResponse!
    getUserDefaultPaymentMethod(userId: ID!): PaymentMethodResponse!
    getExpiredPaymentMethods(customerId: ID!): PaymentMethodResponse!
    getPaymentMethodsStats(customerId: ID!): StatsResponse!

    # ── Subscription ──────────────────────────────────────────────────
    getSubscription(subscriptionId: ID!): SubscriptionResponse!
    listUserSubscriptions(userId: ID!): SubscriptionResponse!
    """
    El Entitlement del miembro: en **subscriptions**, todas sus Subscriptions
    vigentes — ACTIVE/TRIALING **con el periodo en curso**. Una Suscripcion
    Futura, que se guarda ya como ACTIVE/TRIALING, queda fuera hasta que su
    periodo empieza.

    El campo singular **subscription** esta deprecado: es una vista degradada
    del conjunto para apps antiguas y resuelve con la misma regla determinista
    que los escalares del auth payload — gana la vigente ilimitada y, en empate
    o si ninguna lo es, la de periodo mas lejano. Ver ADR 0006.

    Sin directiva @deprecated: SubscriptionResponse.subscription es el tipo de
    respuesta compartido por getSubscription y por catorce mutaciones, donde el
    campo singular es la respuesta correcta y no esta deprecado. La deprecacion
    es de *esta* query, no del campo.
    """
    getActiveSubscription(userId: ID!): SubscriptionResponse!
    """
    Las Suscripciones Futuras del miembro, aparte del Entitlement: programadas y
    sin dar acceso todavia, de la mas proxima a la mas lejana, en
    \`subscriptions\`. Un miembro solo consulta las suyas; las de otro exigen ser
    administrador.
    """
    getFutureSubscriptions(userId: ID!): SubscriptionResponse!
    getSubscriptionsStats: SubscriptionsStatsResponse!
    getSubscriptionHistory(subscriptionId: ID!): SubscriptionHistoryResponse!

    # ── Pagos (Stripe Connect — Modelo B) ──────────────────────────────
    """
    SetupIntent para añadir una tarjeta a la cuenta master de la plataforma.
    Usar cuando el ADMIN paga su mensualidad a la plataforma (tú).
    """
    getClientToken: ClientTokenResponse!
    """
    SetupIntent para añadir una tarjeta dentro de la cuenta Stripe conectada
    de una empresa. Usar cuando un CLIENTE paga a su gym/admin — el dinero
    va a la cuenta del admin y tu comisión se retiene automáticamente.
    """
    getCompanyClientToken(companyId: ID!): ClientTokenResponse!
    """Devuelve el estado de conexión Stripe Connect de una empresa (admin)."""
    getPaymentConnectionStatus(companyId: ID!): PaymentConnectionStatusResponse!

    # ── Invoice ───────────────────────────────────────────────────────
    getInvoice(invoiceId: ID!): InvoiceResponse!
    listUserInvoices(userId: ID!): InvoiceResponse!
    getInvoicesBySubscription(subscriptionId: ID!): InvoiceResponse!
    getOverdueInvoices: InvoiceResponse!
    getUpcomingInvoices(userId: ID!): InvoiceResponse!
    getInvoiceStats(userId: ID!): InvoiceStatsResponse!

    # ── Transaction ───────────────────────────────────────────────────
    getTransaction(transactionId: ID!): TransactionResponse!
    listUserTransactions(userId: ID!, limit: Int): TransactionResponse!
    getTransactionsByStatus(userId: ID!, status: TransactionStatus!, limit: Int): TransactionResponse!
    getSuccessfulTransactions(userId: ID!, limit: Int): TransactionResponse!
    getFailedTransactions(userId: ID!, limit: Int): TransactionResponse!
    getUserTransactionsSummary(userId: ID!): TransactionResponse!

    # ── Company ───────────────────────────────────────────────────────
    getCompanies(companyId: ID, page: Int, query: String): CompanyResponse!

    # ── SuperAdmin ────────────────────────────────────────────────────
    getGlobalSystemStats: GlobalSystemStatsResponse!
}
`;
