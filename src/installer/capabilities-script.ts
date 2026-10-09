// Uses evaluated Gradle DSL source sets and actual Test task types. It never
// resolves dependency configurations or reaches outside the selected build.
export const CAPABILITIES_INIT_SCRIPT = String.raw`
gradle.projectsEvaluated {
    if (!gradle.includedBuilds.empty) throw new GradleException("Composite builds are not supported by the Android capability model")
    def androidIds = ["com.android.application":"application", "com.android.library":"library",
        "com.android.dynamic-feature":"dynamic-feature", "com.android.test":"test", "com.android.asset-pack":"asset-pack"]
    def projects = gradle.rootProject.allprojects.collectEntries { [(it.path): it] }
    def android = projects.values().findAll { p -> androidIds.keySet().any { p.pluginManager.hasPlugin(it) } }
    def dependencies = projects.collectEntries { key, p ->
        def deps = [] as Set
        p.configurations.each { c -> c.dependencies.withType(org.gradle.api.artifacts.ProjectDependency).each { d ->
            def target = d.metaClass.respondsTo(d, "getPath") ? d.getPath() : d.getDependencyProject().path
            deps.add(target)
        } }
        [(key): deps.toList().sort()]
    }
    def selected = android.collect { it.path } as Set
    for (boolean changed = true; changed;) {
        changed = false
        selected.toList().each { key -> dependencies[key].each { dep -> if (selected.add(dep)) changed = true } }
    }
    def get = { owner, name ->
        if (owner == null) return null
        // Gradle extensions (notably kotlin on AGP 4.x source sets) can be
        // dynamic properties absent from MetaClass. Only absence is optional;
        // a getter failure must not silently remove an editable source root.
        try { return owner."$name" }
        catch (groovy.lang.MissingPropertyException missing) {
            if (missing.property != name) throw missing
            return null
        }
    }
    def modules = selected.toList().sort().collect { key ->
        def p = projects[key]
        if (p == null) throw new GradleException("Project dependency is outside the selected build: " + key)
        def androidId = androidIds.keySet().find { p.pluginManager.hasPlugin(it) }
        def isJvm = p.pluginManager.hasPlugin("java") || p.pluginManager.hasPlugin("org.jetbrains.kotlin.jvm")
        if (androidId == null && !isJvm) throw new GradleException("Unsupported Android project dependency: " + key)
        def extension = p.extensions.findByName("android")
        def sourceSets = androidId != null ? get(extension, "sourceSets") : p.extensions.findByName("sourceSets")
        if (sourceSets == null) throw new GradleException("Cannot inspect source sets for " + key)
        def tests = p.tasks.withType(org.gradle.api.tasks.testing.Test).toList()
        def testOutputs = tests.collectMany { it.testClassesDirs.files.toList() }.collect { it.canonicalPath } as Set
        def buildDir = p.layout.buildDirectory.get().asFile.canonicalFile.toPath()
        def pathOf = { File file ->
            def absolute = file.absoluteFile.toPath().normalize()
            if (file.canonicalFile.toPath().startsWith(buildDir)) throw new GradleException("Generated source directory is not editable: " + absolute)
            absolute.toString()
        }
        def sources = sourceSets.collect { s ->
            def isTest = androidId != null ? (s.name.startsWith("test") || s.name.startsWith("androidTest")) :
                s.output.classesDirs.files.any { testOutputs.contains(it.canonicalPath) }
            def paths = [] as Set
            ["java", "kotlin", "resources", "res", "assets", "aidl", "jni", "jniLibs", "shaders", "mlModels"].each { name ->
                def dirs = get(get(s, name), "srcDirs")
                if (dirs != null) dirs.each { paths.add(pathOf(it) + "/**") }
            }
            def manifest = get(get(s, "manifest"), "srcFile")
            if (manifest != null) paths.add(pathOf(manifest))
            [name:s.name, kind:isTest ? "test" : "production", paths:paths.toList().sort()]
        }.sort { it.name }
        def tasks = tests.collect { t ->
            def match = t.name =~ /^test(.+)UnitTest$/
            [path:t.path, kind:"unit", variant:androidId != null && match.matches() ? match.group(1) : null]
        }
        p.tasks.names.toList().sort().each { name ->
            def path = p.path == ":" ? ":" + name : p.path + ":" + name
            if (name == "assemble" && androidId == null) tasks.add([path:path, kind:"assemble", variant:null])
            else if (androidId != null && name ==~ /^assemble[A-Z][A-Za-z0-9]*$/ && !(name in ["assembleAndroidTest", "assembleUnitTest", "assembleTestFixtures"]) && !name.endsWith("AndroidTest") && !name.endsWith("UnitTest") && !name.endsWith("TestFixtures")) tasks.add([path:path, kind:"assemble", variant:name.substring(8)])
            else if (androidId != null && name == "lint") tasks.add([path:path, kind:"lint", variant:null])
            else if (androidId != null && name ==~ /^lint[A-Z][A-Za-z0-9]*$/ && !["lintVital", "lintFix", "lintAnalyze", "lintReport"].any { name.startsWith(it) }) tasks.add([path:path, kind:"lint", variant:name.substring(4)])
            else if (androidId != null && name ==~ /^connected[A-Z][A-Za-z0-9]*AndroidTest$/) tasks.add([path:path, kind:"device", variant:name.substring(9, name.length()-11)])
        }
        [gradlePath:p.path, directory:p.projectDir.absolutePath, buildFile:p.buildFile.absolutePath,
            type:androidId != null ? androidIds[androidId] : "jvm-library", namespace:get(extension, "namespace")?.toString(),
            applicationId:get(get(extension, "defaultConfig"), "applicationId")?.toString(),
            dependencies:dependencies[key], sources:sources, tasks:tasks.sort { it.path }]
    }
    def json = groovy.json.JsonOutput.toJson([version:1, buildRoot:gradle.rootProject.projectDir.absolutePath, modules:modules])
    println("OPENCODE_ANDROID_ORCHESTRATOR_MODEL=" + java.util.Base64.encoder.encodeToString(json.getBytes("UTF-8")))
}
`;
