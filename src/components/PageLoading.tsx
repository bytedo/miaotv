export function PageLoading() {
  return (
    <div
      role='status'
      aria-live='polite'
      className='pointer-events-none flex min-h-[40vh] w-full flex-col items-center justify-center gap-3 px-4 py-12 text-gray-500 dark:text-gray-400'
    >
      <span
        aria-hidden='true'
        className='h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none'
      />
      <span className='text-sm'>正在加载…</span>
    </div>
  );
}
