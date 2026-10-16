package io.tenvyr.operations;

import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Executable port of the maintenance/anchor/source identity decision tables. */
public final class OperationsCheck {
    private static int cases;
    private static void check(boolean value,String message){cases++;if(!value)throw new AssertionError(message);}
    private static void reject(Runnable work,String message){try{work.run();throw new AssertionError(message);}catch(IllegalArgumentException expected){cases++;}}
    public static void main(String[] args)throws Exception {
        if(args.length>0&&args[0].equals("lock-holder")){Maintenance lock=new Maintenance(Path.of(args[1]));lock.acquire();System.out.println("locked");System.out.flush();Thread.sleep(60000);return;}
        check(Anchors.TABLES.size()==36,"authority inventory covers 36 tables");check(new HashSet<>(Anchors.TABLES).size()==36,"authority inventory has no duplicates");
        ObjectNode manifest=Json.object("version","v0.1.0","algorithm","sha256","verified",true,"sourceRevision","a".repeat(40),"checksum","c".repeat(64),"tables",Anchors.inventory(),"anchors",Json.object("migrationLedgerFingerprint","1".repeat(64),"tableCountFingerprint","2".repeat(64),"planRevisionHashFingerprint","3".repeat(64),"executionAnchor",null,"capsuleAnchor",null));
        Anchors.validateManifest(manifest,"c".repeat(64),"c".repeat(64),"v0.1.0");cases++;
        reject(()->Anchors.validateManifest(null,"c".repeat(64),null,"v0.1.0"),"missing manifest must fail");
        for(String key:List.of("checksum","algorithm","sourceRevision","version","tables","verified")){ObjectNode copy=manifest.deepCopy();copy.remove(key);reject(()->Anchors.validateManifest(copy,"c".repeat(64),null,"v0.1.0"),"missing "+key+" must fail");}
        reject(()->Anchors.validateManifest(manifest,"d".repeat(64),null,"v0.1.0"),"changed dump must fail");reject(()->Anchors.validateManifest(manifest,"c".repeat(64),"d".repeat(64),"v0.1.0"),"changed sidecar must fail");
        for(String key:Anchors.REQUIRED){ObjectNode copy=manifest.deepCopy();((ObjectNode)copy.get("anchors")).putNull(key);reject(()->Anchors.validateManifest(copy,"c".repeat(64),null,"v0.1.0"),"missing "+key+" must fail");}
        ObjectNode snapshot=Anchors.snapshot((db,sql)->sql.contains("count(*)")?String.join("|",Collections.nCopies(36,"0")):"","verify");check(!snapshot.path("tableCountFingerprint").isNull(),"empty snapshot has a structural fingerprint");check(snapshot.path("capsuleAnchor").isNull(),"empty snapshot has no capsule anchor");check(Anchors.compare(snapshot,snapshot).isEmpty(),"same snapshot matches");ObjectNode changed=snapshot.deepCopy();changed.put("migrationLedgerFingerprint","x");check(Anchors.compare(snapshot,changed).size()==1,"changed migration ledger fails");
        for(String state:List.of("absent","malformed")){check(Maintenance.plan(state,null,List.of(Maintenance.ACTIVE)).action().equals("proceed"),"clean active may proceed");check(Maintenance.plan(state,null,List.of(Maintenance.SAFETY)).action().equals("restore-original"),"safety restored if active missing");check(Maintenance.plan(state,null,List.of(Maintenance.ACTIVE,Maintenance.SAFETY)).action().equals("blocked"),"ambiguous active+safety fails closed");check(Maintenance.plan(state,null,List.of()).action().equals("blocked"),"missing authority fails closed");}
        for(String phase:Maintenance.PHASES){check(Maintenance.plan("valid",phase,List.of(Maintenance.ACTIVE,Maintenance.SAFETY)).action().equals(switch(phase){case "complete","verify-done"->"proceed";case "quiescing","swap-active-to-safety"->"restart-original";default->"rollback-candidate";}),"phase decision "+phase);if(!phase.equals("complete"))check(Maintenance.plan("valid",phase,List.of(Maintenance.SAFETY)).action().equals("restore-original"),"missing active restores original at "+phase);}
        check(Maintenance.plan("valid","post-gates",List.of(Maintenance.ACTIVE)).restartServices(),"mid-rollback rename back requires restart");check(Maintenance.failedName(List.of(Maintenance.FAILED)).equals(Maintenance.FAILED+"_1"),"failed candidate name is collision safe");
        reject(()->Operations.validateTarget("latest","v0.1.0"),"floating target fails");reject(()->Operations.validateTarget("v0.1.0","v0.2.0"),"downgrade fails");reject(()->Operations.validateTarget("v0.1.0","v0.1.0"),"equal release fails");Operations.validateTarget("v0.2.0","v0.1.0");cases++;check(Operations.applyMetadata("# retained\nTENVYR_VERSION=v0.1.0\nTENVYR_SOURCE_REVISION=old\nOTHER=value\n","v0.2.0","a".repeat(40)).contains("# retained\nTENVYR_VERSION=v0.2.0\nTENVYR_SOURCE_REVISION="+"a".repeat(40)+"\nOTHER=value\n"),"metadata preserves unrelated lines");check(Operations.imageViolations(" image: tenvyr:latest\n").size()==1,"floating image rejected");
        Path dir=Files.createTempDirectory("tenvyr-java-maintenance-");try {
            Maintenance lock=new Maintenance(dir);lock.acquire();try{new Maintenance(dir).acquire();throw new AssertionError("second owner admitted");}catch(IllegalStateException denied){cases++;}
            try{new Maintenance(dir).clearStale();throw new AssertionError("live lock cleared");}catch(IllegalStateException denied){cases++;}
            String began=null;for(String phase:Maintenance.PHASES){lock.writeJournal(phase,"backup.dump");Maintenance.Journal journal=lock.readJournal();check(journal.state().equals("valid"),"journal readable");if(began==null)began=journal.value().path("startedAt").asText();check(journal.value().path("startedAt").asText().equals(began),"journal stable startedAt");}
            Files.writeString(Path.of(lock.journalPath()+".tmp"),"truncated");check(lock.readJournal().state().equals("valid"),"temporary journal cannot corrupt committed record");Files.writeString(lock.journalPath(),"truncated");check(lock.readJournal().state().equals("malformed"),"malformed journal explicit");lock.clearJournal();check(lock.readJournal().state().equals("absent"),"absent journal explicit");lock.close();
            List<String> childArgs=List.of(Path.of(System.getProperty("java.home"),"bin","java").toString(),"-cp",System.getProperty("java.class.path"),OperationsCheck.class.getName(),"lock-holder",dir.toString());Process child=new ProcessBuilder(childArgs).redirectErrorStream(true).start();try{check(new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream())).readLine().equals("locked"),"crash owner acquired lock");child.destroyForcibly();check(child.waitFor(10,TimeUnit.SECONDS),"crash owner exited");try{new Maintenance(dir).acquire();throw new AssertionError("stale owner silently reclaimed");}catch(IllegalStateException stale){check(stale.getMessage().contains("stale-maintenance-state"),"crashed owner lock fails closed");}check(new Maintenance(dir).clearStale(),"explicit dead owner clear works");}finally{child.destroyForcibly();}
        }finally{try(var files=Files.walk(dir)){for(Path file:files.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(file);}}
        System.out.println("OperationsCheck PASS cases="+cases);
    }
}
