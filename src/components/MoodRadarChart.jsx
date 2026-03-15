import React from 'react';
import { RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer } from 'recharts';

const MoodRadarChart = ({ data }) => {
  const chartData = [
    { subject: '心情', value: data.mood, fullMark: 5 },
    { subject: '睡眠', value: data.sleep, fullMark: 5 },
    { subject: '精神', value: data.energy, fullMark: 5 },
    { subject: '压力', value: 6 - data.stress, fullMark: 5 }, // 反转压力值，数值越高表示压力越小
    { subject: '社交', value: data.social, fullMark: 5 }
  ];

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={chartData}>
          <PolarGrid />
          <PolarAngleAxis dataKey="subject" className="text-sm" />
          <PolarRadiusAxis 
            angle={90} 
            domain={[0, 5]} 
            tick={false}
            axisLine={false}
          />
          <Radar
            name="状态指数"
            dataKey="value"
            stroke="#8B5CF6"
            fill="#8B5CF6"
            fillOpacity={0.3}
            strokeWidth={2}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default MoodRadarChart;
