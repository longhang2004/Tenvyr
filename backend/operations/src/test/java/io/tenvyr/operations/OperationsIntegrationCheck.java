package io.tenvyr.operations;

import java.nio.file.Path;

/** Executes the retained real Docker recovery suite against Java services AND Java maintenance. */
public final class OperationsIntegrationCheck {
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args.length>0?args[0]:".").toAbsolutePath();
        ProcessBuilder builder=new ProcessBuilder("node","--test","scripts/self-hosted/recovery.test.mjs").directory(root.toFile()).inheritIO();
        builder.environment().put("TENVYR_RECOVERY_BACKEND","java");
        int status=builder.start().waitFor();if(status!=0)throw new AssertionError("Real Docker Java recovery suite exited "+status);
        System.out.println("OperationsIntegrationCheck: retained Docker recovery suite passed with Java services/maintenance");
    }
}
