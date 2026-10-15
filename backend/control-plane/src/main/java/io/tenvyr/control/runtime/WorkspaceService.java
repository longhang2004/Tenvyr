package io.tenvyr.control.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

public final class WorkspaceService {
    private final Db db;
    public WorkspaceService(Db db){this.db=db;}
    public static String resolveWorkspacePath(String path){if(path==null||path.isBlank()||path.length()>4096||path.indexOf(0)>=0)throw new RuntimeFailure("WORKSPACE_PATH_INVALID","Invalid workspace path");try{Path real=Path.of(path).toRealPath();if(!Files.isDirectory(real))throw new RuntimeFailure("WORKSPACE_PATH_INVALID","Workspace is not a directory");return real.toString();}catch(java.io.IOException e){throw new RuntimeFailure("WORKSPACE_PATH_INVALID","Workspace path cannot be resolved");}}
    public static ObjectNode captureGitIdentity(String path){String root=git(path,List.of("rev-parse","--show-toplevel"));if(root==null||root.isBlank())return Json.object("repoRoot",null,"branch",null,"headSha",null,"dirty",null,"note","git repository identity not detectable (not a git work tree, git unavailable, or probe bounded)");String branch=git(path,List.of("rev-parse","--abbrev-ref","HEAD")),sha=git(path,List.of("rev-parse","HEAD")),status=git(path,List.of("status","--porcelain"));return Json.object("repoRoot",root.length()>4096?root.substring(0,4096):root,"branch",branch==null||branch.isBlank()?null:branch.substring(0,Math.min(255,branch.length())),"headSha",sha!=null&&sha.matches("[0-9a-fA-F]{40}")?sha:null,"dirty",status==null?null:!status.isEmpty());}
    private static String git(String cwd,List<String> args){ProcessBoundary.Result r=ProcessBoundary.run("git",args,Path.of(cwd),gitEnvironment(),10000,4096);return Objects.equals(r.status(),0)&&!r.exceeded()&&!r.timedOut()?r.stdout().trim():null;}
    static Map<String,String> gitEnvironment(){return Map.of("PATH",System.getenv().getOrDefault("PATH",""),"GIT_OPTIONAL_LOCKS","0","GIT_TERMINAL_PROMPT","0");}
    public ObjectNode freezeSnapshot(String path){String real=resolveWorkspacePath(path);return snapshot("ws:"+real,real);}
    private static ObjectNode snapshot(String id,String real){ObjectNode identity=captureGitIdentity(real);ObjectNode result=Json.object("schemaVersion",1,"workspaceId",id,"path",real,"capturedAt",Instant.now().toString());result.setAll(identity);return result;}
    public ObjectNode createWorkspace(JsonNode input){return db.transaction(tx->createWorkspace(tx,input));}
    public ObjectNode createWorkspace(Db tx,JsonNode input){String real=resolveWorkspacePath(Json.text(input,"path"));tx.execute("SELECT pg_advisory_xact_lock(hashtext(?))",real);ObjectNode existing=tx.one("SELECT * FROM workspaces WHERE path=? FOR UPDATE",real);String id=existing==null?UUID.randomUUID().toString():Json.text(existing,"id");ObjectNode snap=snapshot(id,real);String name=Json.text(input,"name",existing==null?Path.of(real).getFileName().toString():Json.text(existing,"name"));if(name.length()>255)name=name.substring(0,255);if(existing==null)tx.insert("workspaces",Json.object("id",id,"name",name,"path",real,"snapshot",snap));else tx.update("workspaces",id,Json.object("name",name,"snapshot",snap,"updatedAt",Instant.now().toString()));return Json.object("id",id,"snapshot",snap);}
    public ObjectNode refreshWorkspace(String id){return db.transaction(tx->{ObjectNode row=tx.one("SELECT * FROM workspaces WHERE id=? FOR UPDATE",id);if(row==null)throw new RuntimeFailure("WORKSPACE_NOT_FOUND","Workspace missing");ObjectNode snap=snapshot(id,resolveWorkspacePath(Json.text(row,"path")));tx.update("workspaces",id,Json.object("snapshot",snap,"updatedAt",Instant.now().toString()));return snap;});}
    public List<ObjectNode> list(){return db.query("SELECT * FROM workspaces ORDER BY \"updatedAt\" DESC");}
}
