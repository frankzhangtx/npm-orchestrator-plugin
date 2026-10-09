// Optional local Maven repository for reproducible legacy builds after Gradle's
// version-specific resolution metadata has been evicted. It must contain real
// dependency artifacts and POMs; no product Gradle configuration is changed.
export const legacyRepositories = process.env.ORCHESTRATOR_TEST_MAVEN_REPOSITORY
  ? `maven { url ${JSON.stringify(process.env.ORCHESTRATOR_TEST_MAVEN_REPOSITORY)} }`
  : "maven { url 'https://maven.aliyun.com/repository/google' }; maven { url 'https://maven.aliyun.com/repository/public' }";
