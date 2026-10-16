package io.tenvyr.worker;

import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/** Cooperative cancellation; handlers may outlive ownership but cannot deliver late results. */
public final class Cancellation {
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();
    public boolean isCancelled() { return cancelled.get(); }
    public void cancel() { if (cancelled.compareAndSet(false,true)) { synchronized(this) { notifyAll(); } for (Runnable listener:listeners) { try { listener.run(); } catch (RuntimeException ignored) {} } listeners.clear(); } }
    public AutoCloseable onCancel(Runnable listener) { listeners.add(listener); if(isCancelled() && listeners.remove(listener)) listener.run(); return () -> listeners.remove(listener); }
    public synchronized boolean await(long millis) throws InterruptedException { long end=System.nanoTime()+millis*1_000_000L; while(!isCancelled()) { long left=end-System.nanoTime(); if(left<=0)return true; wait(Math.max(1,left/1_000_000L)); } return false; }
}
