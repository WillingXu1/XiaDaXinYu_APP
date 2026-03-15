// 转化率分析组件
import React from 'react';
import { useApp } from '../context/AppContext';
import { behaviorTracker } from '../services/behaviorTracker';
import { experimentManager } from '../services/experimentManager';

const ConversionAnalytics = () => {
  const { trackEvent } = useApp();

  const getAnalyticsData = () => {
    const events = behaviorTracker.getEvents();

    // 计算转化率指标
    const pageViews = events.filter(e => e.eventName === 'page_view').length;
    const moodRecords = events.filter(e => e.eventName === 'mood_recorded').length;
    const aiMessages = events.filter(e => e.eventName === 'ai_message_sent').length;

    const moodConversionRate = pageViews > 0 ? (moodRecords / pageViews * 100).toFixed(1) : 0;
    const aiEngagementRate = pageViews > 0 ? (aiMessages / pageViews * 100).toFixed(1) : 0;

    return {
      pageViews,
      moodRecords,
      aiMessages,
      moodConversionRate,
      aiEngagementRate
    };
  };

  const analytics = getAnalyticsData();

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-gray-800 mb-4">转化率分析</h3>
      <div className="grid grid-cols-2 gap-4">
        <div className="text-center">
          <div className="text-2xl font-bold text-purple-600">{analytics.moodConversionRate}%</div>
          <div className="text-sm text-gray-600">情绪记录转化率</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-blue-600">{analytics.aiEngagementRate}%</div>
          <div className="text-sm text-gray-600">AI对话参与率</div>
        </div>
      </div>
      <div className="mt-4 text-xs text-gray-500">
        基于 {analytics.pageViews} 次页面访问
      </div>
    </div>
  );
};

export default ConversionAnalytics;