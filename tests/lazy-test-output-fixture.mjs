// A real Gradle producer exposes mapped output only after it has executed,
// like the Android ASM transform that broke WordPress discovery/collection.
export const lazyTestOutputFixture = String.raw`
abstract class TransformTestClasses extends DefaultTask {
    @InputFiles
    @PathSensitive(PathSensitivity.RELATIVE)
    abstract ConfigurableFileCollection getInputClasses()
    @OutputDirectory
    abstract DirectoryProperty getClassesDirectory()
    @TaskAction
    void transform() {
        project.copy { from inputClasses; into classesDirectory.get().asFile }
    }
}
afterEvaluate {
    tasks.withType(Test).toList().each { testTask ->
        def originalClasses = testTask.testClassesDirs
        def transform = tasks.register("transform" + testTask.name.capitalize() + "Classes", TransformTestClasses) {
            inputClasses.from(originalClasses)
            classesDirectory.set(layout.buildDirectory.dir("mapped-test-classes/" + testTask.name))
        }
        testTask.testClassesDirs = files(transform.flatMap { it.classesDirectory }.map { it.asFile })
    }
}
`;
