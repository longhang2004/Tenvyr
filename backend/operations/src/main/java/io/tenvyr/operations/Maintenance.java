package io.tenvyr.operations;

import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Json;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

/** File ownership deliberately survives SIGKILL: an absent owner cannot prove descendants are gone. */
public final class Maintenance implements AutoCloseable {
    public static final String ACTIVE="tenvyr",SAFETY="tenvyr_pre_restore",ISOLATED="tenvyr_restore",FAILED="tenvyr_failed_promotion";
    public static final List<String> PHASES=List.of("verify-done","quiescing","swap-active-to-safety","swap-verified-to-active","post-gates","complete");
    public record Journal(String state,ObjectNode value){}
    public record Plan(String action,boolean restartServices){}
    private final Path directory,lock,journal;private final String token=UUID.randomUUID().toString();private boolean owned;
    public Maintenance(Path directory){this.directory=directory.toAbsolutePath().normalize();lock=this.directory.resolve(".maintenance.lock");journal=this.directory.resolve(".recovery-journal.json");}
    public Path journalPath(){return journal;}
    public void acquire()throws IOException {Files.createDirectories(directory);ObjectNode owner=Json.object("pid",ProcessHandle.current().pid(),"startedAt",Instant.now().toString(),"token",token);try(FileChannel file=FileChannel.open(lock,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){ByteBuffer bytes=ByteBuffer.wrap(Json.stringify(owner).getBytes(StandardCharsets.UTF_8));while(bytes.hasRemaining())file.write(bytes);file.force(true);owned=true;syncDirectory(directory);}catch(FileAlreadyExistsException contention){ObjectNode previous=owner();String reason=previous==null?"maintenance lock owner is unreadable":alive(previous)?"maintenance operation already active":"stale-maintenance-state: owner is dead, external maintenance children may still be running";throw new IllegalStateException(reason+"; inspect docker/pg_dump/pg_restore/psql descendants, then explicitly run maintenance --clear-stale-lock and restore --reconcile");}}
    private ObjectNode owner(){try{return Json.requireObject(Json.parse(Files.readString(lock)),"Maintenance owner");}catch(Exception e){return null;}}
    private static boolean alive(ObjectNode owner){long pid=owner.path("pid").asLong(-1);if(pid<1)return true;try{return ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);}catch(SecurityException inaccessible){return true;}}
    public boolean clearStale()throws IOException {if(!Files.exists(lock))return false;ObjectNode recorded=owner();if(recorded==null||alive(recorded))throw new IllegalStateException("refusing to clear unreadable or live owner's maintenance lock");Files.delete(lock);syncDirectory(directory);return true;}
    public Journal readJournal(){if(!Files.exists(journal))return new Journal("absent",null);try{ObjectNode n=Json.requireObject(Json.parse(Files.readString(journal)),"Recovery journal");if(n.path("operation").asText().equals("promote")&&PHASES.contains(n.path("phase").asText()))return new Journal("valid",n);}catch(Exception malformed){}return new Journal("malformed",null);}
    public void writeJournal(String phase,String backup)throws IOException {if(!PHASES.contains(phase))throw new IllegalArgumentException("Unknown recovery journal phase");Journal before=readJournal();String now=Instant.now().toString();ObjectNode record=Json.object("operation","promote","phase",phase,"backup",backup,"startedAt",before.value()==null?now:before.value().path("startedAt").asText(now),"updatedAt",now);atomicWrite(journal,Json.stringify(record).getBytes(StandardCharsets.UTF_8));}
    public void clearJournal()throws IOException {Files.deleteIfExists(journal);syncDirectory(directory);}
    public static void atomicWrite(Path target,byte[] bytes)throws IOException {Files.createDirectories(target.toAbsolutePath().getParent());Path tmp=target.resolveSibling(target.getFileName()+".tmp-"+UUID.randomUUID());try{try(FileChannel file=FileChannel.open(tmp,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){ByteBuffer data=ByteBuffer.wrap(bytes);while(data.hasRemaining())file.write(data);file.force(true);}Files.move(tmp,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);syncDirectory(target.toAbsolutePath().getParent());}finally{Files.deleteIfExists(tmp);}}
    private static void syncDirectory(Path path)throws IOException {try(FileChannel directory=FileChannel.open(path,StandardOpenOption.READ)){directory.force(true);}catch(UnsupportedOperationException unsupported){/* Directory fsync is not provided by every filesystem. */}}
    public static String failedName(Collection<String> names){if(!names.contains(FAILED))return FAILED;for(int i=1;i<=100;i++)if(!names.contains(FAILED+"_"+i))return FAILED+"_"+i;throw new IllegalStateException("no free failed-promotion name; archive preserved candidates first");}
    public static Plan plan(String state,String phase,Collection<String> names){boolean active=names.contains(ACTIVE),safety=names.contains(SAFETY);if(!state.equals("valid")){if(safety)return new Plan(active?"blocked":"restore-original",false);return new Plan(active?"proceed":"blocked",false);}if("complete".equals(phase))return new Plan("proceed",false);if(safety){if(!active)return new Plan("restore-original",false);if(Set.of("swap-verified-to-active","post-gates").contains(phase))return new Plan("rollback-candidate",false);if(Set.of("quiescing","swap-active-to-safety").contains(phase))return new Plan("restart-original",false);return new Plan("proceed",false);}if(!active)return new Plan("blocked",false);if(Set.of("quiescing","swap-active-to-safety").contains(phase))return new Plan("restart-original",false);return new Plan("proceed",Set.of("swap-verified-to-active","post-gates").contains(phase));}
    @Override public void close()throws IOException {if(!owned)return;ObjectNode owner=owner();if(owner!=null&&token.equals(owner.path("token").asText())){Files.deleteIfExists(lock);syncDirectory(directory);}owned=false;}
}
